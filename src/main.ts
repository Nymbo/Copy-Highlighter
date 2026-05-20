import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin } from "@codemirror/view";

const LOST_KEYUP_FALLBACK_MS = 5000;
const NON_KEYBOARD_COPY_FALLBACK_MS = 650;
const MAX_DOM_FLASH_RECTS = 80;

interface CopyHighlighterSettings {
	highlightColor: string;
	editorOpacity: number;
	renderedOpacity: number;
	borderRadius: number;
	enableRenderedMarkdownHighlight: boolean;
	nonKeyboardCopyDurationMs: number;
	lostKeyupFallbackMs: number;
}

type FlashRange = {
	from: number;
	to: number;
};

type ClearHighlight = () => void;

const DEFAULT_SETTINGS: CopyHighlighterSettings = {
	highlightColor: "#ffd54f",
	editorOpacity: 0.5,
	renderedOpacity: 0.46,
	borderRadius: 3,
	enableRenderedMarkdownHighlight: true,
	nonKeyboardCopyDurationMs: NON_KEYBOARD_COPY_FALLBACK_MS,
	lostKeyupFallbackMs: LOST_KEYUP_FALLBACK_MS,
};

const addFlash = StateEffect.define<FlashRange[]>();
const clearFlash = StateEffect.define<void>();

const flashMark = Decoration.mark({
	class: "copy-highlighter-editor-highlight",
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

	constructor(private getSettings: () => CopyHighlighterSettings) {}

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

		const settings = this.getSettings();
		const fallbackMs = this.isCopyChordHeld()
			? settings.lostKeyupFallbackMs
			: settings.nonKeyboardCopyDurationMs;

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

export default class CopyHighlighterPlugin extends Plugin {
	settings: CopyHighlighterSettings = DEFAULT_SETTINGS;
	private highlightSession = new HighlightSession(() => this.settings);
	private domHighlights = new Set<HTMLElement>();

	async onload() {
		await this.loadSettings();
		this.applyCssVariables();
		this.addSettingTab(new CopyHighlighterSettingTab(this.app, this));

		this.highlightSession.register(() => {
			this.clearDomHighlights();
		});

		this.registerEditorExtension(copyFlashExtension(this.highlightSession));

		this.registerDomEvent(activeDocument, "keydown", (event) => {
			this.highlightSession.handleKeyDown(event);
		}, true);

		this.registerDomEvent(activeDocument, "keyup", (event) => {
			this.highlightSession.handleKeyUp(event);
		}, true);

		this.registerDomEvent(activeWindow, "blur", () => {
			this.highlightSession.resetKeys();
		});

		this.registerDomEvent(activeDocument, "visibilitychange", () => {
			if (activeDocument.visibilityState === "hidden") {
				this.highlightSession.resetKeys();
			}
		});

		// CodeMirror handles editor selections. This fallback covers copied text in
		// rendered Markdown or other Obsidian-owned DOM content.
		this.registerDomEvent(activeDocument, "copy", (event) => {
			this.flashDomSelection(event);
		}, true);
	}

	onunload() {
		this.clearDomHighlights();
		activeDocument.body.style.removeProperty("--copy-highlighter-editor-background");
		activeDocument.body.style.removeProperty("--copy-highlighter-border-radius");
	}

	private flashDomSelection(event: ClipboardEvent) {
		if (!this.settings.enableRenderedMarkdownHighlight) {
			return;
		}

		const target = event.target;

		if (!(target instanceof Element)) {
			return;
		}

		if (target.closest(".cm-editor") !== null) {
			return;
		}

		const selection = target.ownerDocument.getSelection();

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
			const ownerDocument = range.commonAncestorContainer.ownerDocument ?? activeDocument;
			const ownerWindow = ownerDocument.defaultView ?? activeWindow;
			const overlay = ownerDocument.createElement("div");

			overlay.className = "copy-highlighter-dom-highlight";
			overlay.style.left = `${rect.left + ownerWindow.scrollX}px`;
			overlay.style.top = `${rect.top + ownerWindow.scrollY}px`;
			overlay.style.width = `${rect.width}px`;
			overlay.style.height = `${rect.height}px`;
			overlay.style.backgroundColor = hexToRgba(
				this.settings.highlightColor,
				this.settings.renderedOpacity
			);
			overlay.style.borderRadius = `${this.settings.borderRadius}px`;

			ownerDocument.body.appendChild(overlay);
			this.domHighlights.add(overlay);
		}
	}

	private clearDomHighlights() {
		for (const highlight of this.domHighlights) {
			highlight.remove();
		}

		this.domHighlights.clear();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<CopyHighlighterSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.applyCssVariables();
	}

	resetSettings() {
		this.settings = { ...DEFAULT_SETTINGS };
		this.applyCssVariables();
	}

	private applyCssVariables() {
		activeDocument.body.style.setProperty(
			"--copy-highlighter-editor-background",
			hexToRgba(this.settings.highlightColor, this.settings.editorOpacity)
		);
		activeDocument.body.style.setProperty(
			"--copy-highlighter-border-radius",
			`${this.settings.borderRadius}px`
		);
	}
}

class CopyHighlighterSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: CopyHighlighterPlugin) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName("Appearance")
			.setHeading();

		new Setting(containerEl)
			.setName("Highlight color")
			.setDesc("The color used when copied text is highlighted.")
			.addColorPicker((colorPicker) => {
				colorPicker
					.setValue(this.plugin.settings.highlightColor)
					.onChange(async (value) => {
						this.plugin.settings.highlightColor = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Editor opacity")
			.setDesc("How strong the highlight appears in live editor text.")
			.addSlider((slider) => {
				slider
					.setLimits(0.1, 1, 0.05)
					.setValue(this.plugin.settings.editorOpacity)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.editorOpacity = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Rendered text opacity")
			.setDesc("How strong the highlight appears outside the editor, such as reading view.")
			.addSlider((slider) => {
				slider
					.setLimits(0.1, 1, 0.05)
					.setValue(this.plugin.settings.renderedOpacity)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.renderedOpacity = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Corner radius")
			.setDesc("Rounds the highlight corners.")
			.addSlider((slider) => {
				slider
					.setLimits(0, 12, 1)
					.setValue(this.plugin.settings.borderRadius)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.borderRadius = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Highlight rendered Markdown")
			.setDesc("Also show copy confirmation when copying from reading view and other rendered text.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.enableRenderedMarkdownHighlight)
					.onChange(async (value) => {
						this.plugin.settings.enableRenderedMarkdownHighlight = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Mouse/menu copy duration")
			.setDesc("How long the highlight stays visible for non-keyboard copy actions.")
			.addText((text) => {
				text
					.setPlaceholder(String(DEFAULT_SETTINGS.nonKeyboardCopyDurationMs))
					.setValue(String(this.plugin.settings.nonKeyboardCopyDurationMs))
					.onChange(async (value) => {
						this.plugin.settings.nonKeyboardCopyDurationMs = parsePositiveInt(
							value,
							DEFAULT_SETTINGS.nonKeyboardCopyDurationMs
						);
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "number";
				text.inputEl.min = "100";
				text.inputEl.step = "50";
			});

		new Setting(containerEl)
			.setName("Lost keyup fallback")
			.setDesc("Cleanup delay if Obsidian does not receive the key release event.")
			.addText((text) => {
				text
					.setPlaceholder(String(DEFAULT_SETTINGS.lostKeyupFallbackMs))
					.setValue(String(this.plugin.settings.lostKeyupFallbackMs))
					.onChange(async (value) => {
						this.plugin.settings.lostKeyupFallbackMs = parsePositiveInt(
							value,
							DEFAULT_SETTINGS.lostKeyupFallbackMs
						);
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "number";
				text.inputEl.min = "500";
				text.inputEl.step = "100";
			});

		new Setting(containerEl)
			.setName("Reset settings")
			.setDesc("Restore the default appearance and timing.")
			.addButton((button) => {
				button
					.setButtonText("Restore defaults")
					.onClick(async () => {
						this.plugin.resetSettings();
						await this.plugin.saveSettings();
						this.display();
					});
			});
	}
}

function hexToRgba(hex: string, opacity: number) {
	const normalized = hex.replace("#", "");
	const isValidHex = /^[0-9a-fA-F]{6}$/.test(normalized);

	if (!isValidHex) {
		return hexToRgba(DEFAULT_SETTINGS.highlightColor, opacity);
	}

	const red = parseInt(normalized.slice(0, 2), 16);
	const green = parseInt(normalized.slice(2, 4), 16);
	const blue = parseInt(normalized.slice(4, 6), 16);
	const alpha = Math.max(0, Math.min(opacity, 1));

	return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function parsePositiveInt(value: string, fallback: number) {
	const parsed = Number.parseInt(value, 10);

	if (Number.isFinite(parsed) && parsed > 0) {
		return parsed;
	}

	return fallback;
}
