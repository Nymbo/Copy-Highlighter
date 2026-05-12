import { Plugin } from "obsidian";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin } from "@codemirror/view";

const LOST_KEYUP_FALLBACK_MS = 5000;
const NON_KEYBOARD_COPY_FALLBACK_MS = 650;
const MAX_DOM_FLASH_RECTS = 80;

type FlashRange = {
	from: number;
	to: number;
};

type ClearHighlight = () => void;

const addFlash = StateEffect.define<FlashRange[]>();
const clearFlash = StateEffect.define<void>();

const flashMark = Decoration.mark({
	class: "copy-flasher-editor-highlight",
});

const flashField = StateField.define<DecorationSet>({
	create() {
		return Decoration.none;
	},
	update(decorations, transaction) {
		decorations = decorations.map(transaction.changes);

		for (const effect of transaction.effects) {
			if (effect.is(clearFlash)) {
				decorations = Decoration.none;
			}

			if (effect.is(addFlash)) {
				const builder = new RangeSetBuilder<Decoration>();

				for (const range of effect.value) {
					if (range.from < range.to) {
						builder.add(range.from, range.to, flashMark);
					}
				}

				decorations = builder.finish();
			}
		}

		return decorations;
	},
	provide: (field) => EditorView.decorations.from(field),
});

class HighlightSession {
	private clearers = new Set<ClearHighlight>();
	private ctrlOrMetaDown = false;
	private cDown = false;
	private fallbackTimer: number | null = null;

	register(clearHighlight: ClearHighlight) {
		this.clearers.add(clearHighlight);

		return () => {
			this.clearers.delete(clearHighlight);
		};
	}

	handleKeyDown(event: KeyboardEvent) {
		if (event.key === "Control" || event.key === "Meta") {
			this.ctrlOrMetaDown = true;
		}

		if (event.key.toLowerCase() === "c") {
			this.cDown = true;
		}
	}

	handleKeyUp(event: KeyboardEvent) {
		if (event.key === "Control" || event.key === "Meta") {
			this.ctrlOrMetaDown = false;
		}

		if (event.key.toLowerCase() === "c") {
			this.cDown = false;
		}

		if (!this.isCopyChordHeld()) {
			this.clear();
		}
	}

	beginCopyHighlight() {
		if (this.fallbackTimer !== null) {
			window.clearTimeout(this.fallbackTimer);
		}

		const fallbackMs = this.isCopyChordHeld()
			? LOST_KEYUP_FALLBACK_MS
			: NON_KEYBOARD_COPY_FALLBACK_MS;

		// This is only a cleanup guard. Normal Ctrl/Cmd+C clears on keyup.
		this.fallbackTimer = window.setTimeout(() => {
			this.clear();
		}, fallbackMs);
	}

	clear() {
		if (this.fallbackTimer !== null) {
			window.clearTimeout(this.fallbackTimer);
			this.fallbackTimer = null;
		}

		for (const clearHighlight of this.clearers) {
			clearHighlight();
		}
	}

	resetKeys() {
		this.ctrlOrMetaDown = false;
		this.cDown = false;
		this.clear();
	}

	private isCopyChordHeld() {
		return this.ctrlOrMetaDown && this.cDown;
	}
}

function copyFlashExtension(highlightSession: HighlightSession) {
	class CopyFlashView {
		private unregister: (() => void) | null = null;

		constructor(private view: EditorView) {}

		registerClearer() {
			if (this.unregister === null) {
				this.unregister = highlightSession.register(() => {
					this.view.dispatch({
						effects: clearFlash.of(),
					});
				});
			}
		}

		destroy() {
			if (this.unregister !== null) {
				this.unregister();
			}
		}

		flashCopiedSelection() {
			const ranges = this.view.state.selection.ranges
				.filter((range) => !range.empty)
				.map((range) => ({
					from: range.from,
					to: range.to,
				}));

			if (ranges.length === 0) {
				return;
			}

			this.registerClearer();
			this.view.dispatch({
				effects: addFlash.of(ranges),
			});
			highlightSession.beginCopyHighlight();
		}
	}

	const copyFlashViewPlugin = ViewPlugin.define(
		(view) => new CopyFlashView(view),
		{
			eventHandlers: {
				copy(_event, view) {
					const plugin = view.plugin(copyFlashViewPlugin);
					plugin?.flashCopiedSelection();
				},
			},
		}
	);

	return [
		flashField,
		copyFlashViewPlugin,
	];
}

export default class CopyFlasherPlugin extends Plugin {
	private highlightSession = new HighlightSession();
	private domHighlights = new Set<HTMLElement>();

	async onload() {
		this.highlightSession.register(() => {
			this.clearDomHighlights();
		});

		this.registerEditorExtension(copyFlashExtension(this.highlightSession));

		this.registerDomEvent(document, "keydown", (event) => {
			this.highlightSession.handleKeyDown(event);
		}, true);

		this.registerDomEvent(document, "keyup", (event) => {
			this.highlightSession.handleKeyUp(event);
		}, true);

		this.registerDomEvent(window, "blur", () => {
			this.highlightSession.resetKeys();
		});

		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "hidden") {
				this.highlightSession.resetKeys();
			}
		});

		// CodeMirror handles editor selections. This fallback covers copied text in
		// rendered Markdown or other Obsidian-owned DOM content.
		this.registerDomEvent(document, "copy", (event) => {
			this.flashDomSelection(event);
		}, true);
	}

	private flashDomSelection(event: ClipboardEvent) {
		const target = event.target;

		if (!(target instanceof Element)) {
			return;
		}

		if (target.closest(".cm-editor") !== null) {
			return;
		}

		const selection = window.getSelection();

		if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
			return;
		}

		const activeRoot = this.app.workspace.containerEl;

		if (selection.anchorNode === null || selection.focusNode === null) {
			return;
		}

		if (!activeRoot.contains(selection.anchorNode) || !activeRoot.contains(selection.focusNode)) {
			return;
		}

		for (let index = 0; index < selection.rangeCount; index += 1) {
			this.flashRange(selection.getRangeAt(index));
		}

		this.highlightSession.beginCopyHighlight();
	}

	private flashRange(range: Range) {
		const rects = Array.from(range.getClientRects())
			.filter((rect) => rect.width > 0 && rect.height > 0)
			.slice(0, MAX_DOM_FLASH_RECTS);

		for (const rect of rects) {
			const overlay = document.createElement("div");

			overlay.className = "copy-flasher-dom-highlight";
			overlay.style.left = `${rect.left + window.scrollX}px`;
			overlay.style.top = `${rect.top + window.scrollY}px`;
			overlay.style.width = `${rect.width}px`;
			overlay.style.height = `${rect.height}px`;

			document.body.appendChild(overlay);
			this.domHighlights.add(overlay);
		}
	}

	private clearDomHighlights() {
		for (const highlight of this.domHighlights) {
			highlight.remove();
		}

		this.domHighlights.clear();
	}
}
