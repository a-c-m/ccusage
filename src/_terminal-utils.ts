import type { WriteStream } from 'node:tty';
import process from 'node:process';
import * as ansiEscapes from 'ansi-escapes';
import stringWidth from 'string-width';

/**
 * Terminal control sequences for live display updates
 */
export const TERMINAL_CONTROL = {
	// Cursor control
	HIDE_CURSOR: ansiEscapes.cursorHide,
	SHOW_CURSOR: ansiEscapes.cursorShow,

	// Screen control
	CLEAR_SCREEN: ansiEscapes.clearScreen,
	CLEAR_LINE: ansiEscapes.eraseLine,
	MOVE_TO_TOP: ansiEscapes.cursorTo(0, 0),

	// Movement
	MOVE_UP: (n: number) => ansiEscapes.cursorUp(n),
	MOVE_DOWN: (n: number) => ansiEscapes.cursorDown(n),
	MOVE_TO_COLUMN: (n: number) => ansiEscapes.cursorTo(n - 1, undefined),
} as const;

/**
 * Manages terminal state for live updates
 */
export class TerminalManager {
	private stream: WriteStream;
	private cursorHidden = false;
	private originalWrite: typeof process.stdout.write;

	constructor(stream: WriteStream = process.stdout) {
		this.stream = stream;
		this.originalWrite = stream.write.bind(stream);
	}

	/**
	 * Hides the terminal cursor
	 */
	hideCursor(): void {
		if (!this.cursorHidden && this.stream.isTTY) {
			this.stream.write(TERMINAL_CONTROL.HIDE_CURSOR);
			this.cursorHidden = true;
		}
	}

	/**
	 * Shows the terminal cursor
	 */
	showCursor(): void {
		if (this.cursorHidden && this.stream.isTTY) {
			this.stream.write(TERMINAL_CONTROL.SHOW_CURSOR);
			this.cursorHidden = false;
		}
	}

	/**
	 * Clears the entire screen and moves cursor to top
	 */
	clearScreen(): void {
		if (this.stream.isTTY) {
			this.stream.write(TERMINAL_CONTROL.CLEAR_SCREEN);
			this.stream.write(TERMINAL_CONTROL.MOVE_TO_TOP);
		}
	}

	/**
	 * Clears the current line
	 */
	clearLine(): void {
		if (this.stream.isTTY) {
			this.stream.write(TERMINAL_CONTROL.CLEAR_LINE);
		}
	}

	/**
	 * Moves cursor up by n lines
	 */
	moveUp(lines: number): void {
		if (this.stream.isTTY && lines > 0) {
			this.stream.write(TERMINAL_CONTROL.MOVE_UP(lines));
		}
	}

	/**
	 * Moves cursor to beginning of line
	 */
	moveToLineStart(): void {
		if (this.stream.isTTY) {
			this.stream.write(TERMINAL_CONTROL.MOVE_TO_COLUMN(1));
		}
	}

	/**
	 * Writes text to the stream
	 */
	write(text: string): void {
		this.stream.write(text);
	}

	/**
	 * Gets terminal width
	 */
	get width(): number {
		return this.stream.columns || 80;
	}

	/**
	 * Gets terminal height
	 */
	get height(): number {
		return this.stream.rows || 24;
	}

	/**
	 * Checks if the stream is a TTY
	 */
	get isTTY(): boolean {
		return this.stream.isTTY ?? false;
	}

	/**
	 * Ensures cursor is shown on cleanup
	 */
	cleanup(): void {
		this.showCursor();
	}
}

/**
 * Creates a progress bar string
 * @param value - Current value
 * @param max - Maximum value
 * @param width - Width of the progress bar
 * @param options - Display options
 * @param options.showPercentage - Whether to show percentage
 * @param options.showValues - Whether to show current/max values
 * @param options.fillChar - Character for filled portion
 * @param options.emptyChar - Character for empty portion
 * @param options.leftBracket - Left bracket character
 * @param options.rightBracket - Right bracket character
 * @param options.colors - Color configuration
 * @param options.colors.low - Color for low percentage
 * @param options.colors.medium - Color for medium percentage
 * @param options.colors.high - Color for high percentage
 * @param options.colors.critical - Color for critical percentage
 * @returns Formatted progress bar string
 */
export function createProgressBar(
	value: number,
	max: number,
	width: number,
	options: {
		showPercentage?: boolean;
		showValues?: boolean;
		fillChar?: string;
		emptyChar?: string;
		leftBracket?: string;
		rightBracket?: string;
		colors?: {
			low?: string;
			medium?: string;
			high?: string;
			critical?: string;
		};
	} = {},
): string {
	const {
		showPercentage = true,
		showValues = false,
		fillChar = '█',
		emptyChar = '░',
		leftBracket = '[',
		rightBracket = ']',
		colors = {},
	} = options;

	const percentage = max > 0 ? Math.min(100, (value / max) * 100) : 0;
	const fillWidth = Math.round((percentage / 100) * width);
	const emptyWidth = width - fillWidth;

	// Determine color based on percentage
	let color = '';
	if (colors.critical != null && percentage >= 90) {
		color = colors.critical;
	}
	else if (colors.high != null && percentage >= 80) {
		color = colors.high;
	}
	else if (colors.medium != null && percentage >= 50) {
		color = colors.medium;
	}
	else if (colors.low != null) {
		color = colors.low;
	}

	// Build progress bar
	let bar = leftBracket;
	if (color !== '') {
		bar += color;
	}
	bar += fillChar.repeat(fillWidth);
	bar += emptyChar.repeat(emptyWidth);
	if (color !== '') {
		bar += '\u001B[0m'; // Reset color
	}
	bar += rightBracket;

	// Add percentage or values
	if (showPercentage) {
		bar += ` ${percentage.toFixed(1)}%`;
	}
	if (showValues) {
		bar += ` (${value}/${max})`;
	}

	return bar;
}

/**
 * Centers text within a given width
 * @param text - Text to center
 * @param width - Total width
 * @returns Centered text with padding
 */
export function centerText(text: string, width: number): string {
	const textLength = stringWidth(text);
	if (textLength >= width) {
		return text;
	}

	const leftPadding = Math.floor((width - textLength) / 2);
	const rightPadding = width - textLength - leftPadding;

	return ' '.repeat(leftPadding) + text + ' '.repeat(rightPadding);
}
