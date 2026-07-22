import sharp from 'sharp';
async function toRaw(input) {
    const img = sharp(input).ensureAlpha();
    const meta = await img.metadata();
    const raw = await img.raw().toBuffer();
    return { data: raw, width: meta.width, height: meta.height, channels: 4 };
}
function sobelEdge(img, useAlpha = false) {
    const { width, height, data, channels } = img;
    const gray = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
        const r = data[i * channels];
        const g = data[i * channels + 1];
        const b = data[i * channels + 2];
        const a = data[i * channels + 3];
        if (useAlpha && a < 20) {
            gray[i] = 0;
        }
        else {
            gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        }
    }
    const edges = new Uint8Array(width * height);
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const gx = -gray[(y - 1) * width + (x - 1)] + gray[(y - 1) * width + (x + 1)] +
                -2 * gray[y * width + (x - 1)] + 2 * gray[y * width + (x + 1)] +
                -gray[(y + 1) * width + (x - 1)] + gray[(y + 1) * width + (x + 1)];
            const gy = -gray[(y - 1) * width + (x - 1)] - 2 * gray[(y - 1) * width + x] - gray[(y - 1) * width + (x + 1)] +
                gray[(y + 1) * width + (x - 1)] + 2 * gray[(y + 1) * width + x] + gray[(y + 1) * width + (x + 1)];
            edges[y * width + x] = Math.min(255, Math.sqrt(gx * gx + gy * gy));
        }
    }
    return edges;
}
function findPieceBounds(img) {
    let left = img.width, top = img.height, right = 0, bottom = 0;
    for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
            const a = img.data[(y * img.width + x) * img.channels + 3];
            if (a > 20) {
                if (x < left)
                    left = x;
                if (x > right)
                    right = x;
                if (y < top)
                    top = y;
                if (y > bottom)
                    bottom = y;
            }
        }
    }
    return { left, top, right, bottom };
}
function detectGap(bg, pz, bounds) {
    const { width, data, channels } = bg;
    const bgEdges = sobelEdge(bg);
    const scores = [];
    const pieceW = bounds.right - bounds.left + 1;
    const pieceMask = [];
    const stepX = Math.max(1, Math.floor(pieceW / 24));
    const stepY = Math.max(1, Math.floor((bounds.bottom - bounds.top + 1) / 24));
    for (let y = bounds.top; y <= bounds.bottom; y += stepY) {
        for (let x = bounds.left; x <= bounds.right; x += stepX) {
            const a = pz.data[(y * pz.width + x) * pz.channels + 3];
            if (a > 20) {
                pieceMask.push({ dx: x - bounds.left, y });
            }
        }
    }
    for (let ox = 10; ox <= width - pieceW; ox++) {
        let brightnessSum = 0;
        let brightnessSqSum = 0;
        let edgeSum = 0;
        let count = 0;
        for (const pt of pieceMask) {
            const px = ox + pt.dx;
            const py = pt.y;
            if (px >= width)
                continue;
            const idx = (py * width + px) * channels;
            const brightness = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
            brightnessSum += brightness;
            brightnessSqSum += brightness * brightness;
            edgeSum += bgEdges[py * width + px];
            count++;
        }
        if (count === 0) {
            scores.push({ x: ox, score: 0 });
            continue;
        }
        const meanBrightness = brightnessSum / count;
        const variance = Math.max(0, brightnessSqSum / count - meanBrightness * meanBrightness);
        const brightnessStd = Math.sqrt(variance);
        const meanEdge = edgeSum / count;
        const score = meanBrightness - brightnessStd * 0.35 + meanEdge * 0.12;
        scores.push({ x: ox, score });
    }
    scores.sort((a, b) => b.score - a.score);
    return scores;
}
function nccMatch(bg, pz, bounds) {
    const { width: bgW, height: bgH, data: bgData, channels: bgCh } = bg;
    const { width: pzW, data: pzData, channels: pzCh } = pz;
    const pieceW = bounds.right - bounds.left + 1;
    const pieceH = bounds.bottom - bounds.top + 1;
    const tmplPixels = [];
    let tmplSum = 0;
    const stepX = Math.max(1, Math.floor(pieceW / 30));
    const stepY = Math.max(1, Math.floor(pieceH / 30));
    for (let dy = bounds.top; dy <= bounds.bottom; dy += stepY) {
        for (let dx = bounds.left; dx <= bounds.right; dx += stepX) {
            const a = pzData[(dy * pzW + dx) * pzCh + 3];
            if (a < 30)
                continue;
            const idx = (dy * pzW + dx) * pzCh;
            const gray = 0.299 * pzData[idx] + 0.587 * pzData[idx + 1] + 0.114 * pzData[idx + 2];
            tmplPixels.push({ dx: dx - bounds.left, dy: dy - bounds.top, gray });
            tmplSum += gray;
        }
    }
    const tmplMean = tmplSum / tmplPixels.length;
    let tmplVar = 0;
    for (const p of tmplPixels)
        tmplVar += (p.gray - tmplMean) ** 2;
    const tmplStd = Math.sqrt(tmplVar) || 1;
    const scores = [];
    for (let ox = 10; ox <= bgW - pieceW; ox++) {
        let crossSum = 0;
        let bgSum = 0;
        let bgSum2 = 0;
        let count = 0;
        for (const p of tmplPixels) {
            const bx = ox + p.dx;
            const by = bounds.top + p.dy;
            if (bx >= bgW || by >= bgH)
                continue;
            const idx = (by * bgW + bx) * bgCh;
            const gray = 0.299 * bgData[idx] + 0.587 * bgData[idx + 1] + 0.114 * bgData[idx + 2];
            crossSum += (p.gray - tmplMean) * gray;
            bgSum += gray;
            bgSum2 += gray * gray;
            count++;
        }
        if (count === 0) {
            scores.push({ x: ox, score: 0 });
            continue;
        }
        const bgMean = bgSum / count;
        let bgVar = 0;
        for (const p of tmplPixels) {
            const bx = ox + p.dx;
            const by = bounds.top + p.dy;
            if (bx >= bgW || by >= bgH)
                continue;
            const idx = (by * bgW + bx) * bgCh;
            const gray = 0.299 * bgData[idx] + 0.587 * bgData[idx + 1] + 0.114 * bgData[idx + 2];
            bgVar += (gray - bgMean) ** 2;
        }
        const bgStd = Math.sqrt(bgVar) || 1;
        const ncc = crossSum / (tmplStd * bgStd);
        scores.push({ x: ox, score: ncc });
    }
    scores.sort((a, b) => b.score - a.score);
    return scores;
}
function edgeMatch(bg, pz, bounds) {
    const bgEdges = sobelEdge(bg);
    const pzEdges = sobelEdge(pz, true);
    const pieceW = bounds.right - bounds.left + 1;
    const edgePoints = [];
    for (let y = bounds.top; y <= bounds.bottom; y++) {
        for (let x = bounds.left; x <= bounds.right; x++) {
            const a = pz.data[(y * pz.width + x) * pz.channels + 3];
            const e = pzEdges[y * pz.width + x];
            if (a > 20 && e > 30) {
                edgePoints.push({ x: x - bounds.left, y, strength: e });
            }
        }
    }
    edgePoints.sort((a, b) => b.strength - a.strength);
    const sampled = edgePoints.slice(0, Math.min(edgePoints.length, 800));
    const scores = [];
    const maxX = bg.width - pieceW;
    for (let ox = 10; ox <= maxX; ox++) {
        let totalScore = 0;
        let count = 0;
        for (const pt of sampled) {
            const bx = ox + pt.x;
            const by = pt.y;
            if (bx >= 0 && bx < bg.width && by >= 0 && by < bg.height) {
                const bgEdgeVal = bgEdges[by * bg.width + bx];
                totalScore += bgEdgeVal;
                count++;
            }
        }
        scores.push({ x: ox, score: count > 0 ? totalScore / count : 0 });
    }
    scores.sort((a, b) => b.score - a.score);
    return scores;
}
function contourMatch(bg, pz, bounds) {
    const bgEdges = sobelEdge(bg);
    const contourPoints = [];
    const minX = bounds.left;
    const minY = bounds.top;
    const pieceW = bounds.right - bounds.left + 1;
    for (let y = bounds.top; y <= bounds.bottom; y++) {
        for (let x = bounds.left; x <= bounds.right; x++) {
            const idx = (y * pz.width + x) * pz.channels + 3;
            const alpha = pz.data[idx];
            if (alpha <= 20)
                continue;
            let isBoundary = false;
            for (let oy = -1; oy <= 1 && !isBoundary; oy++) {
                for (let ox = -1; ox <= 1; ox++) {
                    if (ox === 0 && oy === 0)
                        continue;
                    const nx = x + ox;
                    const ny = y + oy;
                    if (nx < 0 || nx >= pz.width || ny < 0 || ny >= pz.height) {
                        isBoundary = true;
                        break;
                    }
                    const neighborAlpha = pz.data[(ny * pz.width + nx) * pz.channels + 3];
                    if (neighborAlpha <= 20) {
                        isBoundary = true;
                        break;
                    }
                }
            }
            if (isBoundary) {
                contourPoints.push({ x: x - minX, y: y - minY });
            }
        }
    }
    const sampled = contourPoints.filter((_, index) => index % 2 === 0);
    const scores = [];
    for (let ox = 10; ox <= bg.width - pieceW; ox++) {
        let sum = 0;
        let count = 0;
        for (const pt of sampled) {
            const bx = ox + pt.x;
            const by = minY + pt.y;
            if (bx >= 0 && bx < bg.width && by >= 0 && by < bg.height) {
                sum += bgEdges[by * bg.width + bx];
                count++;
            }
        }
        scores.push({ x: ox, score: count > 0 ? sum / count : 0 });
    }
    scores.sort((a, b) => b.score - a.score);
    return scores;
}
function normalizeScores(scores) {
    if (scores.length === 0)
        return new Map();
    const min = Math.min(...scores.map(s => s.score));
    const max = Math.max(...scores.map(s => s.score));
    const range = max - min || 1;
    const map = new Map();
    for (const s of scores) {
        map.set(s.x, (s.score - min) / range);
    }
    return map;
}
function pickConsensusX(fallbackX, candidates) {
    const usable = candidates.filter((candidate) => Number.isFinite(candidate.x) && candidate.x >= 0);
    if (usable.length < 2)
        return fallbackX;
    const tolerance = 14;
    let bestCluster = null;
    for (const anchor of usable) {
        const members = usable.filter((candidate) => Math.abs(candidate.x - anchor.x) <= tolerance);
        if (members.length < 2)
            continue;
        const totalWeight = members.reduce((sum, member) => sum + member.weight, 0);
        const center = members.reduce((sum, member) => sum + member.x * member.weight, 0) / totalWeight;
        const spread = members.reduce((sum, member) => sum + Math.abs(member.x - center), 0) / members.length;
        const cluster = {
            members,
            count: members.length,
            weight: totalWeight,
            spread,
        };
        if (!bestCluster ||
            cluster.count > bestCluster.count ||
            (cluster.count === bestCluster.count && cluster.weight > bestCluster.weight) ||
            (cluster.count === bestCluster.count && cluster.weight === bestCluster.weight && cluster.spread < bestCluster.spread)) {
            bestCluster = cluster;
        }
    }
    if (!bestCluster)
        return fallbackX;
    const avg = bestCluster.members.reduce((sum, member) => sum + member.x * member.weight, 0) /
        bestCluster.weight;
    return Math.round(avg);
}
export async function templateMatch(backgroundInput, puzzleInput) {
    const bg = await toRaw(backgroundInput);
    const pz = await toRaw(puzzleInput);
    const bounds = findPieceBounds(pz);
    const pieceW = bounds.right - bounds.left + 1;
    const pieceH = bounds.bottom - bounds.top + 1;
    const edgeScores = edgeMatch(bg, pz, bounds);
    const contourScores = contourMatch(bg, pz, bounds);
    const gapScores = detectGap(bg, pz, bounds);
    const nccScores = nccMatch(bg, pz, bounds);
    const edgeNorm = normalizeScores(edgeScores);
    const contourNorm = normalizeScores(contourScores);
    const gapNorm = normalizeScores(gapScores);
    const nccNorm = normalizeScores(nccScores);
    const combined = [];
    const W_CONTOUR = 0.6;
    const W_EDGE = 0.2;
    const W_GAP = 0.15;
    const W_NCC = 0.05;
    for (let ox = 10; ox <= bg.width - pieceW; ox++) {
        const c = contourNorm.get(ox) ?? 0;
        const e = edgeNorm.get(ox) ?? 0;
        const g = gapNorm.get(ox) ?? 0;
        const n = nccNorm.get(ox) ?? 0;
        combined.push({ x: ox, score: c * W_CONTOUR + e * W_EDGE + g * W_GAP + n * W_NCC });
    }
    combined.sort((a, b) => b.score - a.score);
    const best = combined[0];
    const edgeTop = edgeScores[0];
    const contourTop = contourScores[0];
    const gapTop = gapScores[0];
    const nccTop = nccScores[0];
    const consensusX = pickConsensusX(best.x, [
        { x: edgeTop?.x ?? -1, weight: 1.0 },
        { x: contourTop?.x ?? -1, weight: 1.0 },
        { x: gapTop?.x ?? -1, weight: 0.9 },
        { x: nccTop?.x ?? -1, weight: 0.9 },
    ]);
    const consensus = combined.find((score) => score.x === consensusX);
    const consensusIsUsable = !!consensus &&
        consensus.score >= best.score * 0.9;
    const final = consensusIsUsable ? consensus : best;
    return {
        x: final.x,
        targetLeftX: Math.max(0, final.x - bounds.left),
        confidence: final.score,
        scores: combined.slice(0, 10),
        method: final.x === best.x
            ? (consensus && !consensusIsUsable ? 'ensemble(contour+edge+gap+ncc, consensus_rejected)' : 'ensemble(contour+edge+gap+ncc)')
            : 'consensus(contour+edge+gap+ncc)',
        edgeX: edgeTop?.x ?? -1,
        contourX: contourTop?.x ?? -1,
        gapX: gapTop?.x ?? -1,
        nccX: nccTop?.x ?? -1,
        pieceBounds: {
            left: bounds.left,
            top: bounds.top,
            right: bounds.right,
            bottom: bounds.bottom,
            width: pieceW,
            height: pieceH,
        },
    };
}
//# sourceMappingURL=vision.js.map