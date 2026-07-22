#!/usr/bin/env node
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
function parseArgs() {
    const args = process.argv.slice(2);
    const flags = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (!arg.startsWith('--'))
            continue;
        const key = arg.slice(2);
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
            flags[key] = next;
            i++;
        }
        else {
            flags[key] = true;
        }
    }
    const run = String(flags.run || '');
    if (!run) {
        throw new Error('Missing --run <run-id-or-path>');
    }
    const runDir = path.isAbsolute(run)
        ? run
        : path.resolve(process.cwd(), 'isolated-runs', run);
    return {
        runDir,
        outputDir: path.resolve(process.cwd(), String(flags['output-dir'] || 'analysis-visual-run')),
    };
}
async function readJson(filePath) {
    try {
        return JSON.parse(await readFile(filePath, 'utf8'));
    }
    catch {
        return null;
    }
}
function latestDataLength(summary) {
    const timeline = summary?.captchaFlow?.timeline || [];
    for (let i = timeline.length - 1; i >= 0; i--) {
        const length = timeline[i]?.captchaVerifyParamInfo?.dataLength;
        if (typeof length === 'number' && Number.isFinite(length))
            return length;
    }
    return null;
}
function svgText(text, width, height, bg, fg) {
    const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="${bg}"/>
    <text x="12" y="${Math.min(24, height - 8)}" font-family="Arial, sans-serif" font-size="18" fill="${fg}">${safe}</text>
  </svg>`);
}
async function main() {
    const flags = parseArgs();
    const attemptEntries = await readdir(flags.runDir, { withFileTypes: true });
    const attempts = attemptEntries
        .filter((entry) => entry.isDirectory() && /^attempt-\d+/.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    if (!attempts.length) {
        throw new Error(`No attempt directories found in ${flags.runDir}`);
    }
    await mkdir(flags.outputDir, { recursive: true });
    const columns = [
        ['puzzle', 'puzzle-open-state.window.png'],
        ['release', 'release-state.window.png'],
        ['outcome', 'post-wait-state.window.png', 'outcome-captcha.window.png'],
        ['outcome-full', 'outcome-captcha.png', 'post-wait-state.png'],
        ['img-release', 'release-state.img-box.png'],
    ];
    const cellW = 360;
    const cellH = 390;
    const labelH = 34;
    const columnLabelH = 24;
    const composites = [];
    for (let row = 0; row < attempts.length; row++) {
        const attempt = attempts[row];
        const attemptDir = path.join(flags.runDir, attempt);
        const summary = await readJson(path.join(attemptDir, 'summary.json'));
        const dataLength = latestDataLength(summary);
        const header = `${attempt} ${summary?.verifyCode || 'n/a'} success=${!!summary?.success} err=${summary?.releasePositionErrorPx ?? 'n/a'} dataLen=${dataLength ?? 'n/a'}`;
        composites.push({
            input: svgText(header, cellW * columns.length, labelH, '#222', summary?.success ? '#8ff0a4' : '#ffb4b4'),
            left: 0,
            top: row * cellH,
        });
        for (let column = 0; column < columns.length; column++) {
            const [label, fileName, fallbackFileName] = columns[column];
            composites.push({
                input: svgText(label, cellW, columnLabelH, '#333', '#fff'),
                left: column * cellW,
                top: row * cellH + labelH,
            });
            const filePath = path.join(attemptDir, fileName);
            const fallbackPath = fallbackFileName ? path.join(attemptDir, fallbackFileName) : null;
            const imagePath = existsSync(filePath) ? filePath : fallbackPath && existsSync(fallbackPath) ? fallbackPath : null;
            if (!imagePath)
                continue;
            const image = await sharp(imagePath)
                .resize({
                width: cellW,
                height: cellH - labelH - columnLabelH,
                fit: 'inside',
                background: '#eeeeee',
            })
                .png()
                .toBuffer();
            composites.push({
                input: image,
                left: column * cellW,
                top: row * cellH + labelH + columnLabelH,
            });
        }
    }
    const runName = path.basename(flags.runDir);
    const outputPath = path.join(flags.outputDir, `${runName}-contact-sheet.png`);
    await sharp({
        create: {
            width: cellW * columns.length,
            height: cellH * attempts.length,
            channels: 4,
            background: '#f2f2f2',
        },
    })
        .composite(composites)
        .png()
        .toFile(outputPath);
    console.log(`Saved: ${outputPath}`);
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
//# sourceMappingURL=report-visual-run.js.map