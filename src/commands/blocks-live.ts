/**
 * @fileoverview Live monitoring display for the blocks command
 *
 * This module implements the --live flag functionality for the blocks command,
 * providing a real-time dashboard of Claude usage. It uses the LiveMonitor class
 * for efficient incremental data loading and presents a formatted terminal UI
 * that updates at regular intervals.
 *
 * The display includes:
 * - Session progress and timing
 * - Token usage with burn rate
 * - Cost projections
 * - Model information
 */

import type { SessionBlock } from '../_session-blocks.ts';
import process from 'node:process';
import pc from 'picocolors';
import { calculateBurnRate, projectBlockUsage } from '../_session-blocks.ts';
import { formatCurrency, formatModelsDisplay, formatNumber } from '../_utils.ts';
import { LiveMonitor } from '../live-monitor.internal.js';
import { logger } from '../logger.ts';
import { centerText, createProgressBar, formatDuration, stripAnsi, TerminalManager } from '../terminal-utils.internal.ts';

/**
 * Live monitoring configuration
 */
export type LiveMonitoringConfig = {
	claudePath: string;
	tokenLimit?: number;
	refreshInterval: number;
	sessionDurationHours: number;
	mode: 'auto' | 'calculate' | 'display';
	order: 'asc' | 'desc';
};

/**
 * Sleep for specified milliseconds
 */
async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * Format token counts with K suffix for display
 * @param num - Number of tokens
 * @returns Formatted string like "12.3k" or "999"
 */
function formatTokensShort(num: number): string {
	if (num >= 1000) {
		return `${(num / 1000).toFixed(1)}k`;
	}
	return num.toString();
}

/**
 * Column layout constants for detail rows
 */
const DETAIL_COLUMN_WIDTHS = {
	col1: 46, // First column width (e.g., "Tokens: 12,345 (50 per min ✓ NORMAL)")
	col2: 37, // Second column width (e.g., "Limit: 60,000 tokens")
} as const;

/**
 * Starts live monitoring of the active session block
 */
export async function startLiveMonitoring(config: LiveMonitoringConfig): Promise<void> {
	const terminal = new TerminalManager();
	let isRunning = true;

	// Setup graceful shutdown
	const cleanup = (): void => {
		isRunning = false;
		terminal.cleanup();
		terminal.clearScreen();
		logger.info('Live monitoring stopped.');
		// Check if process.exitCode is already set before explicitly exiting
		if (process.exitCode == null) {
			process.exit(0);
		}
	};

	process.on('SIGINT', cleanup);
	process.on('SIGTERM', cleanup);

	// Hide cursor for cleaner display
	terminal.hideCursor();

	// Create live monitor with efficient data loading
	using monitor = new LiveMonitor({
		claudePath: config.claudePath,
		sessionDurationHours: config.sessionDurationHours,
		mode: config.mode,
		order: config.order,
	});

	try {
		// eslint-disable-next-line no-unmodified-loop-condition
		while (isRunning) {
			// Get active block with lightweight refresh
			const activeBlock = await monitor.getActiveBlock();

			if (activeBlock == null) {
				terminal.clearScreen();
				terminal.write(pc.yellow('No active session block found. Waiting...\n'));
				await sleep(config.refreshInterval);
				continue;
			}

			// Clear screen and render
			terminal.clearScreen();
			renderLiveDisplay(terminal, activeBlock, config);

			// Wait before next refresh
			await sleep(config.refreshInterval);
		}
	}
	catch (error) {
		terminal.clearScreen();
		const errorMessage = error instanceof Error ? error.message : String(error);
		terminal.write(pc.red(`Error: ${errorMessage}\n`));
		logger.error(`Live monitoring error: ${errorMessage}`);
		await sleep(config.refreshInterval);
	}
}

/**
 * Renders the live display for an active session block
 */
function renderLiveDisplay(terminal: TerminalManager, block: SessionBlock, config: LiveMonitoringConfig): void {
	const width = terminal.width;
	const now = new Date();

	// Calculate key metrics
	const totalTokens = block.tokenCounts.inputTokens + block.tokenCounts.outputTokens;
	const elapsed = (now.getTime() - block.startTime.getTime()) / (1000 * 60);
	const remaining = (block.endTime.getTime() - now.getTime()) / (1000 * 60);

	// Use compact mode for narrow terminals
	if (width < 60) {
		renderCompactLiveDisplay(terminal, block, config, totalTokens, elapsed, remaining);
		return;
	}

	// Clear screen and calculate layout
	terminal.clearScreen();

	// Calculate box dimensions - use full width with minimal margins
	const boxWidth = Math.min(120, width - 2); // Use almost full width, leaving 1 char margin on each side
	const boxMargin = Math.floor((width - boxWidth) / 2);
	const marginStr = ' '.repeat(boxMargin);

	// Calculate progress bar width - fill most of the box
	const labelWidth = 14; // Width for labels like "SESSION"
	const percentWidth = 7; // Width for percentage display
	const shortLabelWidth = 20; // For (XXX.Xk/XXX.Xk) format
	const barWidth = boxWidth - labelWidth - percentWidth - shortLabelWidth - 4; // spacing

	// Session progress
	const sessionDuration = elapsed + remaining;
	const sessionPercent = (elapsed / sessionDuration) * 100;
	const sessionProgressBar = createProgressBar(
		elapsed,
		sessionDuration,
		barWidth,
		{
			showPercentage: false,
			fillChar: pc.cyan('█'),
			emptyChar: pc.gray('░'),
			leftBracket: '[',
			rightBracket: ']',
		},
	);

	// Format times with AM/PM
	const startTime = block.startTime.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
	const endTime = block.endTime.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

	// Draw header
	terminal.write(`${marginStr}┌${'─'.repeat(boxWidth - 2)}┐\n`);
	terminal.write(`${marginStr}│${pc.bold(centerText('CLAUDE CODE - LIVE TOKEN USAGE MONITOR', boxWidth - 2))}│\n`);
	terminal.write(`${marginStr}├${'─'.repeat(boxWidth - 2)}┤\n`);
	terminal.write(`${marginStr}│${' '.repeat(boxWidth - 2)}│\n`);

	// Session section
	const sessionLabel = pc.bold('⏱️ SESSION');
	const sessionBarStr = `${sessionLabel}${''.padEnd(labelWidth - 10)} ${sessionProgressBar} ${sessionPercent.toFixed(1).padStart(6)}%`;
	const sessionBarPadded = sessionBarStr + ' '.repeat(Math.max(0, boxWidth - 3 - stripAnsi(sessionBarStr).length));
	terminal.write(`${marginStr}│ ${sessionBarPadded}│\n`);

	// Session details (indented)
	const col1 = `${pc.gray('Started:')} ${startTime}`;
	const col2 = `${pc.gray('Elapsed:')} ${formatDuration(elapsed)}`;
	const col3 = `${pc.gray('Remaining:')} ${formatDuration(remaining)} (${endTime})`;
	// Calculate actual visible lengths without ANSI codes
	const col1Visible = stripAnsi(col1).length;
	const col2Visible = stripAnsi(col2).length;
	// Fixed column positions - aligned with proper spacing
	const pad1 = ' '.repeat(Math.max(0, DETAIL_COLUMN_WIDTHS.col1 - col1Visible));
	const pad2 = ' '.repeat(Math.max(0, DETAIL_COLUMN_WIDTHS.col2 - col2Visible));
	const sessionDetails = `   ${col1}${pad1}${col2}${pad2}${col3}`;
	const sessionDetailsPadded = sessionDetails + ' '.repeat(Math.max(0, boxWidth - 3 - stripAnsi(sessionDetails).length));
	terminal.write(`${marginStr}│ ${sessionDetailsPadded}│\n`);
	terminal.write(`${marginStr}│${' '.repeat(boxWidth - 2)}│\n`);
	terminal.write(`${marginStr}├${'─'.repeat(boxWidth - 2)}┤\n`);
	terminal.write(`${marginStr}│${' '.repeat(boxWidth - 2)}│\n`);

	// Usage section (always show)
	const tokenPercent = config.tokenLimit != null && config.tokenLimit > 0
		? (totalTokens / config.tokenLimit) * 100
		: 0;

	// Determine bar color based on percentage
	let barColor = pc.green;
	if (tokenPercent > 100) {
		barColor = pc.red;
	}
	else if (tokenPercent > 80) {
		barColor = pc.yellow;
	}

	// Create colored progress bar
	const usageBar = config.tokenLimit != null && config.tokenLimit > 0
		? createProgressBar(
				totalTokens,
				config.tokenLimit,
				barWidth,
				{
					showPercentage: false,
					fillChar: barColor('█'),
					emptyChar: pc.gray('░'),
					leftBracket: '[',
					rightBracket: ']',
				},
			)
		: `[${pc.green('█'.repeat(Math.floor(barWidth * 0.1)))}${pc.gray('░'.repeat(barWidth - Math.floor(barWidth * 0.1)))}]`;

	// Burn rate with better formatting
	const burnRate = calculateBurnRate(block);
	const rateIndicator = burnRate != null
		? (burnRate.tokensPerMinute > 1000 ? pc.red('⚡ HIGH') : burnRate.tokensPerMinute > 500 ? pc.yellow('⚡ MODERATE') : pc.green('✓ NORMAL'))
		: '';
	const rateDisplay = burnRate != null
		? `${Math.round(burnRate.tokensPerMinute)} per min ${rateIndicator}`
		: 'N/A';

	// Usage section
	const usageLabel = pc.bold('🔥 USAGE');
	if (config.tokenLimit != null && config.tokenLimit > 0) {
		const usageBarStr = `${usageLabel}${''.padEnd(labelWidth - 8)} ${usageBar} ${tokenPercent.toFixed(1).padStart(6)}% (${formatTokensShort(totalTokens)}/${formatTokensShort(config.tokenLimit)})`;
		const usageBarPadded = usageBarStr + ' '.repeat(Math.max(0, boxWidth - 3 - stripAnsi(usageBarStr).length));
		terminal.write(`${marginStr}│ ${usageBarPadded}│\n`);

		// Usage details (indented and aligned)
		const col1 = `${pc.gray('Tokens:')} ${formatNumber(totalTokens)} (${rateDisplay})`;
		const col2 = `${pc.gray('Limit:')} ${formatNumber(config.tokenLimit)} tokens`;
		const col3 = `${pc.gray('Cost:')} ${formatCurrency(block.costUSD)}`;
		// Calculate visible lengths without ANSI codes
		const col1Visible = stripAnsi(col1).length;
		const col2Visible = stripAnsi(col2).length;
		// Fixed column positions - match session alignment
		const pad1 = ' '.repeat(Math.max(0, DETAIL_COLUMN_WIDTHS.col1 - col1Visible));
		const pad2 = ' '.repeat(Math.max(0, DETAIL_COLUMN_WIDTHS.col2 - col2Visible));
		const usageDetails = `   ${col1}${pad1}${col2}${pad2}${col3}`;
		const usageDetailsPadded = usageDetails + ' '.repeat(Math.max(0, boxWidth - 3 - stripAnsi(usageDetails).length));
		terminal.write(`${marginStr}│ ${usageDetailsPadded}│\n`);
	}
	else {
		const usageBarStr = `${usageLabel}${''.padEnd(labelWidth - 8)} ${usageBar} (${formatTokensShort(totalTokens)} tokens)`;
		const usageBarPadded = usageBarStr + ' '.repeat(Math.max(0, boxWidth - 3 - stripAnsi(usageBarStr).length));
		terminal.write(`${marginStr}│ ${usageBarPadded}│\n`);

		// Usage details (indented)
		const col1 = `${pc.gray('Tokens:')} ${formatNumber(totalTokens)} (${rateDisplay})`;
		const col3 = `${pc.gray('Cost:')} ${formatCurrency(block.costUSD)}`;
		// Calculate visible length without ANSI codes
		const col1Visible = stripAnsi(col1).length;
		// Fixed column positions - match session alignment
		const pad1 = ' '.repeat(Math.max(0, DETAIL_COLUMN_WIDTHS.col1 - col1Visible));
		const pad2 = ' '.repeat(DETAIL_COLUMN_WIDTHS.col2);
		const usageDetails = `   ${col1}${pad1}${pad2}${col3}`;
		const usageDetailsPadded = usageDetails + ' '.repeat(Math.max(0, boxWidth - 3 - stripAnsi(usageDetails).length));
		terminal.write(`${marginStr}│ ${usageDetailsPadded}│\n`);
	}

	terminal.write(`${marginStr}│${' '.repeat(boxWidth - 2)}│\n`);
	terminal.write(`${marginStr}├${'─'.repeat(boxWidth - 2)}┤\n`);
	terminal.write(`${marginStr}│${' '.repeat(boxWidth - 2)}│\n`);

	// Projections section
	const projection = projectBlockUsage(block);
	if (projection != null) {
		const projectedPercent = config.tokenLimit != null && config.tokenLimit > 0
			? (projection.totalTokens / config.tokenLimit) * 100
			: 0;

		// Determine projection bar color
		let projBarColor = pc.green;
		if (projectedPercent > 100) {
			projBarColor = pc.red;
		}
		else if (projectedPercent > 80) {
			projBarColor = pc.yellow;
		}

		// Create projection bar
		const projectionBar = config.tokenLimit != null && config.tokenLimit > 0
			? createProgressBar(
					projection.totalTokens,
					config.tokenLimit,
					barWidth,
					{
						showPercentage: false,
						fillChar: projBarColor('█'),
						emptyChar: pc.gray('░'),
						leftBracket: '[',
						rightBracket: ']',
					},
				)
			: `[${pc.green('█'.repeat(Math.floor(barWidth * 0.15)))}${pc.gray('░'.repeat(barWidth - Math.floor(barWidth * 0.15)))}]`;

		const limitStatus = config.tokenLimit != null && config.tokenLimit > 0
			? (projectedPercent > 100
					? pc.red('❌ WILL EXCEED LIMIT')
					: projectedPercent > 80
						? pc.yellow('⚠️  APPROACHING LIMIT')
						: pc.green('✓ WITHIN LIMIT'))
			: pc.green('✓ ON TRACK');

		// Projection section
		const projLabel = pc.bold('📈 PROJECTION');
		if (config.tokenLimit != null && config.tokenLimit > 0) {
			const projBarStr = `${projLabel}${''.padEnd(labelWidth - 13)} ${projectionBar} ${projectedPercent.toFixed(1).padStart(6)}% (${formatTokensShort(projection.totalTokens)}/${formatTokensShort(config.tokenLimit)})`;
			const projBarPadded = projBarStr + ' '.repeat(Math.max(0, boxWidth - 3 - stripAnsi(projBarStr).length));
			terminal.write(`${marginStr}│ ${projBarPadded}│\n`);

			// Projection details (indented and aligned)
			const col1 = `${pc.gray('Status:')} ${limitStatus}`;
			const col2 = `${pc.gray('Tokens:')} ${formatNumber(projection.totalTokens)}`;
			const col3 = `${pc.gray('Cost:')} ${formatCurrency(projection.totalCost)}`;
			// Calculate visible lengths (without ANSI codes)
			const col1Visible = stripAnsi(col1).length;
			const col2Visible = stripAnsi(col2).length;
			// Fixed column positions - match session alignment
			const pad1 = ' '.repeat(Math.max(0, DETAIL_COLUMN_WIDTHS.col1 - col1Visible));
			const pad2 = ' '.repeat(Math.max(0, DETAIL_COLUMN_WIDTHS.col2 - col2Visible));
			const projDetails = `   ${col1}${pad1}${col2}${pad2}${col3}`;
			const projDetailsPadded = projDetails + ' '.repeat(Math.max(0, boxWidth - 3 - stripAnsi(projDetails).length));
			terminal.write(`${marginStr}│ ${projDetailsPadded}│\n`);
		}
		else {
			const projBarStr = `${projLabel}${''.padEnd(labelWidth - 13)} ${projectionBar} (${formatTokensShort(projection.totalTokens)} tokens)`;
			const projBarPadded = projBarStr + ' '.repeat(Math.max(0, boxWidth - 3 - stripAnsi(projBarStr).length));
			terminal.write(`${marginStr}│ ${projBarPadded}│\n`);

			// Projection details (indented)
			const col1 = `${pc.gray('Status:')} ${limitStatus}`;
			const col2 = `${pc.gray('Tokens:')} ${formatNumber(projection.totalTokens)}`;
			const col3 = `${pc.gray('Cost:')} ${formatCurrency(projection.totalCost)}`;
			// Calculate visible lengths
			const col1Visible = stripAnsi(col1).length;
			const col2Visible = stripAnsi(col2).length;
			// Fixed column positions - match session alignment
			const pad1 = ' '.repeat(Math.max(0, DETAIL_COLUMN_WIDTHS.col1 - col1Visible));
			const pad2 = ' '.repeat(Math.max(0, DETAIL_COLUMN_WIDTHS.col2 - col2Visible));
			const projDetails = `   ${col1}${pad1}${col2}${pad2}${col3}`;
			const projDetailsPadded = projDetails + ' '.repeat(Math.max(0, boxWidth - 3 - stripAnsi(projDetails).length));
			terminal.write(`${marginStr}│ ${projDetailsPadded}│\n`);
		}

		terminal.write(`${marginStr}│${' '.repeat(boxWidth - 2)}│\n`);
	}

	// Models section
	if (block.models.length > 0) {
		terminal.write(`${marginStr}├${'─'.repeat(boxWidth - 2)}┤\n`);
		const modelsLine = `⚙️  Models: ${formatModelsDisplay(block.models)}`;
		const modelsLinePadded = modelsLine + ' '.repeat(Math.max(0, boxWidth - 3 - stripAnsi(modelsLine).length));
		terminal.write(`${marginStr}│ ${modelsLinePadded}│\n`);
	}

	// Footer
	terminal.write(`${marginStr}├${'─'.repeat(boxWidth - 2)}┤\n`);
	const refreshText = `↻ Refreshing every ${config.refreshInterval / 1000}s  •  Press Ctrl+C to stop`;
	terminal.write(`${marginStr}│${pc.gray(centerText(refreshText, boxWidth - 2))}│\n`);
	terminal.write(`${marginStr}└${'─'.repeat(boxWidth - 2)}┘\n`);
}

/**
 * Renders a compact live display for narrow terminals
 */
function renderCompactLiveDisplay(
	terminal: TerminalManager,
	block: SessionBlock,
	config: LiveMonitoringConfig,
	totalTokens: number,
	elapsed: number,
	remaining: number,
): void {
	const width = terminal.width;

	// Header
	terminal.write(`${pc.bold(centerText('LIVE MONITOR', width))}\n`);
	terminal.write(`${'─'.repeat(width)}\n`);

	// Session info
	const sessionPercent = (elapsed / (elapsed + remaining)) * 100;
	terminal.write(`Session: ${sessionPercent.toFixed(1)}% (${Math.floor(elapsed / 60)}h ${Math.floor(elapsed % 60)}m)\n`);

	// Token usage
	if (config.tokenLimit != null && config.tokenLimit > 0) {
		const tokenPercent = (totalTokens / config.tokenLimit) * 100;
		const status = tokenPercent > 100 ? pc.red('OVER') : tokenPercent > 80 ? pc.yellow('WARN') : pc.green('OK');
		terminal.write(`Tokens: ${formatNumber(totalTokens)}/${formatNumber(config.tokenLimit)} ${status}\n`);
	}
	else {
		terminal.write(`Tokens: ${formatNumber(totalTokens)}\n`);
	}

	// Cost
	terminal.write(`Cost: ${formatCurrency(block.costUSD)}\n`);

	// Burn rate
	const burnRate = calculateBurnRate(block);
	if (burnRate != null) {
		terminal.write(`Rate: ${formatNumber(burnRate.tokensPerMinute)}/min\n`);
	}

	// Footer
	terminal.write(`${'─'.repeat(width)}\n`);
	terminal.write(pc.gray(`Refresh: ${config.refreshInterval / 1000}s | Ctrl+C: stop\n`));
}
