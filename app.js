const presets = {
  silicon: { label: 'Silicon (Al on Si)', d0: 2.0e-7, ea: 0.52, tau: 0.08 },
  sapphire: { label: 'Sapphire (Al on Al₂O₃)', d0: 7.5e-8, ea: 0.62, tau: 0.05 },
  custom: { label: 'Custom / calibrated', d0: 1.0e-7, ea: 0.58, tau: 0.06 }
};

const defaults = {
  sourceDiameter: 20, sourceMaskGap: 100, maskSubstrateGap: 50, maskDiameter: 20,
  substrateTemp: 150, sourceTemp: 1100, depositionTime: 60, material: 'silicon', sticking: 0.92
};
let state = { ...defaults };

const controls = [
  ['sourceDiameter', 'Source aperture diameter', 'mm', 1, 50, 0.5, 'Finite source size drives geometric penumbra at the substrate.'],
  ['sourceMaskGap', 'Source-to-mask gap', 'mm', 20, 250, 1, 'Longer source distance reduces angular spread from the aperture.'],
  ['maskSubstrateGap', 'Mask-to-substrate gap', 'µm', 0, 250, 1, 'The key geometric lever for under-mask broadening.'],
  ['maskDiameter', 'Shadow-mask aperture diameter', 'µm', 1, 100, 0.5, 'Nominal printed feature diameter before blur.'],
  ['substrateTemp', 'Substrate temperature', '°C', -196, 500, 1, 'Controls thermally activated surface diffusion; minimum is liquid nitrogen temperature.'],
  ['sourceTemp', 'Source temperature', '°C', 900, 1300, 5, 'Affects flux weighting weakly here once deposition rate is fixed.'],
  ['depositionTime', 'Residence / deposition time', 's', 1, 300, 1, 'Effective time available for adatoms to diffuse before burial or desorption.'],
  ['sticking', 'Sticking coefficient', '', 0.1, 1, 0.01, 'Scales thickness; low sticking slightly increases effective diffusion distance.']
];

const sweepMetrics = [
  ['fwhm', 'FWHM linewidth (µm)'],
  ['edge', '10–90% edge width (µm)'],
  ['geomSigma', 'Geometric blur σ (µm)'],
  ['diffSigma', 'Diffusion blur σ (µm)'],
  ['totalSigma', 'Total edge σ (µm)'],
  ['diffCoeff', 'Al diffusion coefficient (m²/s)']
];
const controlsEl = document.getElementById('controls');
function buildControls() {
  controlsEl.innerHTML = `<div class="control"><label for="material">Substrate material</label><small>Preset Arrhenius parameters for Al adatom mobility.</small><select id="material">${Object.entries(presets).map(([k,v]) => `<option value="${k}">${v.label}</option>`).join('')}</select></div>`;
  for (const [key, label, unit, min, max, step, help] of controls) {
    controlsEl.insertAdjacentHTML('beforeend', `<div class="control"><label for="${key}"><span>${label}</span><output id="${key}Out"></output></label><small>${help}</small><div class="input-row"><input id="${key}" type="range" min="${min}" max="${max}" step="${step}" /><input id="${key}Number" type="number" min="${min}" max="${max}" step="${step}" aria-label="${label} numeric value" /></div></div>`);
  }
  document.getElementById('material').addEventListener('change', e => { state.material = e.target.value; simulate(); });
  for (const [key,,,,,step] of controls) {
    document.getElementById(key).addEventListener('input', e => { state[key] = Number(e.target.value); simulate(); });
    document.getElementById(`${key}Number`).addEventListener('input', e => {
      if (e.target.value === '') return;
      state[key] = normalizeInputValue(key, Number(e.target.value));
      simulate();
    });
    document.getElementById(`${key}Number`).addEventListener('change', e => {
      state[key] = normalizeInputValue(key, Number(e.target.value || state[key]), step);
      simulate();
    });
  }
}

function syncControls() {
  document.getElementById('material').value = state.material;
  for (const [key,,unit] of controls) {
    document.getElementById(key).value = state[key];
    if (document.activeElement !== document.getElementById(`${key}Number`)) document.getElementById(`${key}Number`).value = state[key];
    document.getElementById(`${key}Out`).textContent = `${format(state[key], 3)} ${unit}`.trim();
  }
}

function diffusionSigmaUm() {
  const p = presets[state.material];
  const kB = 8.617333262e-5; // eV/K
  const T = state.substrateTemp + 273.15;
  const D = p.d0 * Math.exp(-p.ea / (kB * T)); // m^2/s
  const lengthM = Math.sqrt(Math.max(0, 4 * D * p.tau * state.depositionTime / Math.max(state.sticking, 0.05)));
  return { sigma: lengthM * 1e6 / 2, D };
}

function simulateProfile() {
  const radius = state.maskDiameter / 2;
  const geomFull = state.maskSubstrateGap * (state.sourceDiameter / (state.sourceMaskGap * 1000));
  const geomSigma = geomFull / 2.355;
  const diff = diffusionSigmaUm();
  const sourceBoost = 1 + 0.00018 * (state.sourceTemp - 1100); // modest flux-energy proxy
  const sigma = Math.max(0.08, Math.hypot(geomSigma, diff.sigma) * sourceBoost);
  const extent = Math.max(80, radius + 8 * sigma + 20);
  const n = 801, xs = [], ys = [];
  for (let i = 0; i < n; i++) {
    const x = -extent + (2 * extent * i) / (n - 1);
    const left = 0.5 * (1 + erf((x + radius) / (Math.SQRT2 * sigma)));
    const right = 0.5 * (1 - erf((x - radius) / (Math.SQRT2 * sigma)));
    xs.push(x); ys.push(Math.max(0, Math.min(1, left * right)) * state.sticking);
  }
  const peak = Math.max(...ys); const norm = ys.map(y => y / peak);
  return { xs, ys: norm, sigma, geomSigma, diffSigma: diff.sigma, D: diff.D };
}

function metrics(profile) {
  const { xs, ys } = profile;
  const crossings = level => {
    const out = [];
    for (let i = 1; i < ys.length; i++) if ((ys[i-1]-level)*(ys[i]-level) <= 0 && ys[i] !== ys[i-1]) out.push(xs[i-1] + (level-ys[i-1])*(xs[i]-xs[i-1])/(ys[i]-ys[i-1]));
    return out;
  };
  const c50 = crossings(0.5), c10 = crossings(0.1), c90 = crossings(0.9);
  const fwhm = c50.length >= 2 ? c50.at(-1) - c50[0] : 0;
  const edge = c10.length && c90.length ? Math.abs(c90[0] - c10[0]) : 0;
  return { fwhm, edge };
}

function drawMorphology(profile) {
  const c = document.getElementById('morphology'), ctx = c.getContext('2d'), w = c.width, h = c.height;
  ctx.clearRect(0,0,w,h);
  const pad = { left: 72, right: 96, top: 50, bottom: 58 };
  const plotW = w - pad.left - pad.right, plotH = h - pad.top - pad.bottom;
  const img = ctx.createImageData(plotW, plotH);
  const spanUm = Math.max(state.maskDiameter * 1.8, state.maskDiameter + 10 * profile.sigma, 30);
  for (let y=0; y<plotH; y++) for (let x=0; x<plotW; x++) {
    const xUm = (x / (plotW - 1) - 0.5) * spanUm;
    const yUm = (0.5 - y / (plotH - 1)) * spanUm;
    const val = radialValue(Math.hypot(xUm, yUm), profile.sigma, state.maskDiameter/2);
    const i=(y*plotW+x)*4; img.data[i]=20+235*val; img.data[i+1]=45+150*Math.sqrt(val); img.data[i+2]=80+110*(1-val); img.data[i+3]=255;
  }
  ctx.putImageData(img, pad.left, pad.top);
  ctx.strokeStyle='rgba(255,255,255,.7)'; ctx.setLineDash([6,6]); ctx.lineWidth=2;
  ctx.beginPath(); ctx.arc(pad.left + plotW/2, pad.top + plotH/2, (state.maskDiameter / spanUm) * plotW / 2, 0, Math.PI*2); ctx.stroke(); ctx.setLineDash([]);
  drawPlotFrame(ctx, { w, h, pad, title: 'Simulated morphology', xLabel: 'x position (µm)', yLabel: 'y position (µm)', xValues: [-spanUm/2, spanUm/2], yValues: [-spanUm/2, spanUm/2] });
  drawColorbar(ctx, w - 88, pad.top, 16, plotH, 0, 1, 'Normalized thickness');
  ctx.fillStyle='rgba(255,255,255,.82)'; ctx.font='12px system-ui'; ctx.textAlign='left'; ctx.fillText('Dashed circle: nominal aperture', pad.left + 10, pad.top + 20);
}
function radialValue(r, sigma, radius) { return Math.max(0, Math.min(1, 0.5*(1-erf((r-radius)/(Math.SQRT2*sigma))))); }

function drawProfile(profile) {
  const c = document.getElementById('profile'), ctx = c.getContext('2d'), w = c.width, h = c.height;
  const pad = { left: 72, right: 28, top: 42, bottom: 54 };
  ctx.clearRect(0,0,w,h);
  drawLineSeries(ctx, profile.xs, profile.ys, pad.left, pad.top, w - pad.left - pad.right, h - pad.top - pad.bottom, 0, 1, '#66e3ff');
  drawPlotFrame(ctx, { w, h, pad, title: 'Centerline height profile', xLabel: 'position (µm)', yLabel: 'normalized thickness', xValues: profile.xs, yValues: [0, 1] });
  ctx.strokeStyle='rgba(255,211,107,.85)'; ctx.lineWidth=1.5; ctx.setLineDash([5,5]);
  const y50 = pad.top + (h - pad.top - pad.bottom) * 0.5;
  ctx.beginPath(); ctx.moveTo(pad.left, y50); ctx.lineTo(w-pad.right, y50); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle='#ffd36b'; ctx.font='12px system-ui'; ctx.textAlign='right'; ctx.fillText('50% FWHM reference', w - pad.right - 8, y50 - 6);
}


function fittedParameters(profile, metricValues) {
  const p = presets[state.material];
  return {
    exportedAt: new Date().toISOString(),
    substrateMaterial: p.label,
    inputs: { ...state },
    modelParameters: { diffusionPrefactorM2PerS: p.d0, activationEnergyEV: p.ea, residenceScale: p.tau },
    fittedOutputs: {
      fwhmLinewidthUm: metricValues.fwhm,
      edgeWidth10To90Um: metricValues.edge,
      geometricSigmaUm: profile.geomSigma,
      diffusionSigmaUm: profile.diffSigma,
      totalSigmaUm: profile.sigma,
      diffusionCoefficientM2PerS: profile.D,
      dominantBlur: dominantBlur(profile)
    }
  };
}

function dominantBlur(profile) {
  return profile.geomSigma > profile.diffSigma * 1.15 ? 'Geometry' : profile.diffSigma > profile.geomSigma * 1.15 ? 'Diffusion' : 'Mixed';
}

function normalizeInputValue(key, value) {
  const spec = controls.find(([controlKey]) => controlKey === key);
  if (!spec || !Number.isFinite(value)) return state[key];
  const [, , , min, max] = spec;
  return Math.min(max, Math.max(min, value));
}

function downloadText(filename, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], {type}));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportCanvas(canvasId, filename) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = filename;
  a.click();
}

function simulate() {
  syncControls();
  const p = simulateProfile(), m = metrics(p);
  drawMorphology(p); drawProfile(p);
  const dominant = dominantBlur(p);
  document.getElementById('dominantBlur').textContent = dominant;
  document.getElementById('dominantNote').textContent = dominant === 'Geometry' ? 'Reduce mask-substrate gap or source diameter' : dominant === 'Diffusion' ? 'Lower substrate temperature or residence time' : 'Both effects are comparable';
  document.getElementById('fwhm').textContent = `${format(m.fwhm,3)} µm`;
  document.getElementById('edgeWidth').textContent = `${format(m.edge,3)} µm`;
  document.getElementById('geomSigma').textContent = `${format(p.geomSigma,3)} µm`;
  document.getElementById('diffSigma').textContent = `${format(p.diffSigma,3)} µm`;
  document.getElementById('totalSigma').textContent = `${format(p.sigma,3)} µm`;
  document.getElementById('diffCoeff').textContent = `${p.D.toExponential(2)} m²/s`;
  window.currentProfile = p;
  window.currentMetrics = m;
}

function erf(x) { const s=Math.sign(x); x=Math.abs(x); const a1=.254829592,a2=-.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=.3275911; const t=1/(1+p*x); return s*(1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x)); }
function format(v, sig=3) { return Number(v).toLocaleString(undefined, { maximumSignificantDigits: sig }); }

document.getElementById('resetBtn').addEventListener('click', () => { state = { ...defaults }; simulate(); });
document.getElementById('exportBtn').addEventListener('click', () => {
  const p = window.currentProfile; if (!p) return;
  const csv = 'x_um,normalized_thickness\n' + p.xs.map((x,i)=>`${x},${p.ys[i]}`).join('\n');
  downloadText('mini-mbe-profile.csv', csv, 'text/csv');
});
document.getElementById('exportFitBtn').addEventListener('click', () => {
  const p = window.currentProfile, m = window.currentMetrics; if (!p || !m) return;
  downloadText('mini-mbe-fitted-parameters.json', JSON.stringify(fittedParameters(p, m), null, 2), 'application/json');
});

buildControls();
buildSweepControls();
simulate();


function buildSweepControls() {
  const parameterOptions = controls.map(([key, label, unit]) => `<option value="${key}">${label}${unit ? ` (${unit})` : ''}</option>`).join('');
  document.getElementById('sweepXParam').innerHTML = parameterOptions;
  document.getElementById('sweepYParam').insertAdjacentHTML('beforeend', parameterOptions);
  document.getElementById('sweepMetric').innerHTML = sweepMetrics.map(([key, label]) => `<option value="${key}">${label}</option>`).join('');
  document.getElementById('sweepXParam').value = 'maskSubstrateGap';
  document.getElementById('sweepYParam').value = 'substrateTemp';
  setSweepDefaults('X');
  setSweepDefaults('Y');
  for (const id of ['sweepXParam', 'sweepYParam']) document.getElementById(id).addEventListener('change', () => setSweepDefaults(id === 'sweepXParam' ? 'X' : 'Y'));
  document.getElementById('runSweepBtn').addEventListener('click', runSweep);
  document.getElementById('exportSweepBtn').addEventListener('click', exportSweep);
  document.getElementById('sweepMetric').addEventListener('change', () => { if (window.currentSweep) renderSweep(); });
  document.getElementById('cutXSelect').addEventListener('change', () => { if (window.currentSweep) renderSweep(); });
  document.getElementById('cutYSelect').addEventListener('change', () => { if (window.currentSweep) renderSweep(); });
  document.getElementById('showHorizontalCut').addEventListener('change', () => { if (window.currentSweep) renderSweep(); });
  document.getElementById('showVerticalCut').addEventListener('change', () => { if (window.currentSweep) renderSweep(); });
  document.getElementById('exportSweepPlotBtn').addEventListener('click', () => exportCanvas('sweepHeatmap', 'mini-mbe-sweep-plot.png'));
  document.getElementById('exportCutPlotBtn').addEventListener('click', () => exportCanvas('sweepCuts', 'mini-mbe-sweep-cuts.png'));
  document.getElementById('exportMorphologyPlotBtn').addEventListener('click', () => exportCanvas('morphology', 'mini-mbe-morphology.png'));
  document.getElementById('exportProfilePlotBtn').addEventListener('click', () => exportCanvas('profile', 'mini-mbe-profile-plot.png'));
}

function setSweepDefaults(axis) {
  const param = document.getElementById(`sweep${axis}Param`).value;
  if (!param) return;
  const [, , , min, max, step] = controls.find(([key]) => key === param);
  const center = state[param];
  const span = Math.max(step * 4, (max - min) * 0.2);
  document.getElementById(`sweep${axis}Start`).value = format(Math.max(min, center - span / 2), 6);
  document.getElementById(`sweep${axis}Stop`).value = format(Math.min(max, center + span / 2), 6);
  document.getElementById(`sweep${axis}Step`).value = format(Math.max(step, span / 20), 6);
}

function valuesForSweep(axis) {
  const param = document.getElementById(`sweep${axis}Param`).value;
  if (!param) return { param, values: [null] };
  const start = Number(document.getElementById(`sweep${axis}Start`).value);
  const stop = Number(document.getElementById(`sweep${axis}Stop`).value);
  const step = Math.abs(Number(document.getElementById(`sweep${axis}Step`).value));
  if (![start, stop, step].every(Number.isFinite) || step <= 0) throw new Error(`Sweep ${axis} needs finite start/stop and positive step.`);
  const direction = stop >= start ? 1 : -1;
  const out = [];
  for (let v = start, i = 0; direction > 0 ? v <= stop + step * 1e-9 : v >= stop - step * 1e-9; v += direction * step, i++) {
    out.push(normalizeInputValue(param, Number(v.toFixed(10))));
    if (i > 500) throw new Error(`Sweep ${axis} has too many points; increase the step size.`);
  }
  return { param, values: [...new Set(out)] };
}

function computeAt(overrides) {
  const previous = { ...state };
  Object.assign(state, overrides);
  const profile = simulateProfile();
  const metricValues = metrics(profile);
  state = previous;
  return {
    ...overrides,
    fwhm: metricValues.fwhm,
    edge: metricValues.edge,
    geomSigma: profile.geomSigma,
    diffSigma: profile.diffSigma,
    totalSigma: profile.sigma,
    diffCoeff: profile.D,
    dominantBlur: dominantBlur(profile)
  };
}

function runSweep() {
  try {
    const x = valuesForSweep('X');
    const yParam = document.getElementById('sweepYParam').value;
    const y = yParam ? valuesForSweep('Y') : { param: '', values: [null] };
    if (x.param === y.param) throw new Error('Choose two different parameters, or set Y to None.');
    const rows = [];
    for (const yv of y.values) for (const xv of x.values) {
      const overrides = { [x.param]: xv };
      if (y.param) overrides[y.param] = yv;
      rows.push(computeAt(overrides));
    }
    window.currentSweep = { xParam: x.param, xValues: x.values, yParam: y.param, yValues: y.values, rows };
    document.getElementById('sweepStatus').textContent = `${rows.length} simulations complete (${x.values.length} × ${y.param ? y.values.length : 1}).`;
    populateCutSelectors();
    renderSweep();
    simulate();
  } catch (err) {
    document.getElementById('sweepStatus').textContent = err.message;
  }
}

function populateCutSelectors() {
  const sweep = window.currentSweep;
  const cutX = document.getElementById('cutXSelect'), cutY = document.getElementById('cutYSelect');
  cutX.innerHTML = sweep.xValues.map((v, i) => `<option value="${i}">${format(v, 6)}</option>`).join('');
  cutY.innerHTML = sweep.yParam ? sweep.yValues.map((v, i) => `<option value="${i}">${format(v, 6)}</option>`).join('') : '<option value="0">1D sweep</option>';
  cutX.value = Math.floor((sweep.xValues.length - 1) / 2);
  cutY.value = Math.floor((sweep.yValues.length - 1) / 2);
}

function sweepValueAt(xi, yi, metric) {
  const sweep = window.currentSweep;
  const width = sweep.xValues.length;
  return sweep.rows[yi * width + xi][metric];
}

function renderSweep() {
  const sweep = window.currentSweep;
  if (!sweep) return;
  const metric = document.getElementById('sweepMetric').value;
  if (sweep.yParam) drawSweepHeatmap(sweep, metric); else drawSweepLine(sweep, metric);
  drawSweepCuts(sweep, metric);
}

function metricRange(values) {
  const finite = values.filter(Number.isFinite);
  return { min: Math.min(...finite), max: Math.max(...finite) };
}

function colorFor(value, min, max) {
  const t = max === min ? 0.5 : Math.max(0, Math.min(1, (value - min) / (max - min)));
  const r = Math.round(35 + 220 * t), g = Math.round(65 + 130 * Math.sin(Math.PI * t)), b = Math.round(160 + 75 * (1 - t));
  return `rgb(${r},${g},${b})`;
}

function drawSweepHeatmap(sweep, metric) {
  const c = document.getElementById('sweepHeatmap'), ctx = c.getContext('2d'), w = c.width, h = c.height;
  const pad = { left: 82, right: 116, top: 52, bottom: 72 };
  ctx.clearRect(0,0,w,h);
  const vals = sweep.rows.map(r => r[metric]);
  const { min, max } = metricRange(vals);
  const nx = sweep.xValues.length, ny = sweep.yValues.length;
  const plotW = w - pad.left - pad.right, plotH = h - pad.top - pad.bottom;
  for (let yi = 0; yi < ny; yi++) for (let xi = 0; xi < nx; xi++) {
    ctx.fillStyle = colorFor(sweepValueAt(xi, yi, metric), min, max);
    const x = pad.left + xi * plotW / nx, y = pad.top + (ny - 1 - yi) * plotH / ny;
    ctx.fillRect(x, y, Math.ceil(plotW / nx) + 1, Math.ceil(plotH / ny) + 1);
  }
  const cutXi = Number(document.getElementById('cutXSelect').value), cutYi = Number(document.getElementById('cutYSelect').value);
  const showH = document.getElementById('showHorizontalCut').checked;
  const showV = document.getElementById('showVerticalCut').checked;
  ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.lineWidth = 2; ctx.setLineDash([5, 5]);
  if (showV) { const vx = pad.left + (cutXi + .5) * plotW / nx; ctx.beginPath(); ctx.moveTo(vx, pad.top); ctx.lineTo(vx, h-pad.bottom); ctx.stroke(); }
  if (showH) { const hy = pad.top + (ny - cutYi - .5) * plotH / ny; ctx.beginPath(); ctx.moveTo(pad.left, hy); ctx.lineTo(w-pad.right, hy); ctx.stroke(); }
  ctx.setLineDash([]);
  drawPlotFrame(ctx, { w, h, pad, title: `${labelForMetric(metric)} sweep`, xLabel: labelForParam(sweep.xParam), yLabel: labelForParam(sweep.yParam), xValues: sweep.xValues, yValues: sweep.yValues });
  drawColorbar(ctx, w - 78, pad.top, 18, plotH, min, max, labelForMetric(metric));
}

function drawSweepLine(sweep, metric) {
  const c = document.getElementById('sweepHeatmap'), ctx = c.getContext('2d'), w = c.width, h = c.height;
  const pad = { left: 82, right: 38, top: 52, bottom: 72 };
  ctx.clearRect(0,0,w,h);
  const vals = sweep.rows.map(r => r[metric]);
  const { min, max } = metricRange(vals);
  drawLineSeries(ctx, sweep.xValues, vals, pad.left, pad.top, w - pad.left - pad.right, h - pad.top - pad.bottom, min, max, '#66e3ff');
  drawPlotFrame(ctx, { w, h, pad, title: '1D sweep result', xLabel: labelForParam(sweep.xParam), yLabel: labelForMetric(metric), xValues: sweep.xValues, yValues: [min, max] });
}

function drawSweepCuts(sweep, metric) {
  const c = document.getElementById('sweepCuts'), ctx = c.getContext('2d'), w = c.width, h = c.height;
  const pad = { left: 82, right: 36, top: 42, bottom: 56 };
  ctx.clearRect(0,0,w,h);
  const cutXi = Number(document.getElementById('cutXSelect').value), cutYi = Number(document.getElementById('cutYSelect').value);
  const showH = document.getElementById('showHorizontalCut').checked;
  const showV = document.getElementById('showVerticalCut').checked;
  const horizontal = showH ? sweep.xValues.map((_, xi) => sweepValueAt(xi, sweep.yParam ? cutYi : 0, metric)) : [];
  const vertical = showV && sweep.yParam ? sweep.yValues.map((_, yi) => sweepValueAt(cutXi, yi, metric)) : [];
  const all = horizontal.concat(vertical); const { min, max } = metricRange(all.length ? all : [0, 1]);
  if (showH) drawLineSeries(ctx, sweep.xValues, horizontal, pad.left, pad.top, w - pad.left - pad.right, h - pad.top - pad.bottom, min, max, '#66e3ff');
  if (showV && sweep.yParam) drawLineSeries(ctx, sweep.yValues, vertical, pad.left, pad.top, w - pad.left - pad.right, h - pad.top - pad.bottom, min, max, '#ffd36b');
  drawPlotFrame(ctx, { w, h, pad, title: 'Heatmap cuts', xLabel: sweep.yParam ? `${labelForParam(sweep.xParam)} / ${labelForParam(sweep.yParam)}` : labelForParam(sweep.xParam), yLabel: labelForMetric(metric), xValues: sweep.xValues, yValues: [min, max] });
  const hLabel = sweep.yParam ? `${labelForParam(sweep.yParam)}=${format(sweep.yValues[cutYi],4)}` : '1D sweep';
  const vLabel = `${labelForParam(sweep.xParam)}=${format(sweep.xValues[cutXi],4)}`;
  if (showH && showV && sweep.yParam) drawLegend(ctx, pad.left + 12, 14, [{ color: '#66e3ff', label: `Horizontal: ${hLabel}` }, { color: '#ffd36b', label: `Vertical: ${vLabel}` }]);
  else {
    ctx.font = '13px system-ui';
    if (showH) { ctx.fillStyle = '#66e3ff'; ctx.fillText(`Horizontal cut: ${hLabel}`, pad.left + 12, 22); }
    if (showV && sweep.yParam) { ctx.fillStyle = '#ffd36b'; ctx.fillText(`Vertical cut: ${vLabel}`, pad.left + 260, 22); }
    if (!showH && !(showV && sweep.yParam)) { ctx.fillStyle = '#9fb4ca'; ctx.fillText('Select a cut checkbox to display a cut.', pad.left + 12, 22); }
  }
}

function drawLineSeries(ctx, xs, ys, x0, y0, width, height, minY, maxY, color) {
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.beginPath();
  ys.forEach((v, i) => {
    const px = x0 + (maxX === minX ? .5 : (xs[i]-minX)/(maxX-minX)) * width;
    const py = y0 + height - (maxY === minY ? .5 : (v-minY)/(maxY-minY)) * height;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  });
  ctx.stroke();
  ctx.fillStyle = color;
  ys.forEach((v, i) => {
    const px = x0 + (maxX === minX ? .5 : (xs[i]-minX)/(maxX-minX)) * width;
    const py = y0 + height - (maxY === minY ? .5 : (v-minY)/(maxY-minY)) * height;
    ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill();
  });
}

function drawPlotFrame(ctx, cfg) {
  const { w, h, pad, title, xLabel, yLabel, xValues, yValues } = cfg;
  const plotW = w - pad.left - pad.right, plotH = h - pad.top - pad.bottom;
  ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1.25; ctx.strokeRect(pad.left, pad.top, plotW, plotH);
  ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.fillStyle = '#9fb4ca'; ctx.font = '12px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let i=0; i<=4; i++) {
    const x = pad.left + plotW * i / 4;
    ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + plotH); ctx.stroke();
    const tick = interpolateTick(xValues, i / 4); ctx.fillText(format(tick, 4), x, pad.top + plotH + 8);
  }
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let i=0; i<=4; i++) {
    const y = pad.top + plotH * i / 4;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + plotW, y); ctx.stroke();
    const tick = interpolateTick(yValues, 1 - i / 4); ctx.fillText(format(tick, 4), pad.left - 10, y);
  }
  ctx.fillStyle = '#eef6ff'; ctx.font = '700 15px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillText(title, pad.left + plotW / 2, 28);
  ctx.font = '13px system-ui'; ctx.textAlign = 'center'; ctx.fillText(xLabel, pad.left + plotW / 2, h - 18);
  ctx.save(); ctx.translate(20, pad.top + plotH / 2); ctx.rotate(-Math.PI/2); ctx.fillText(yLabel, 0, 0); ctx.restore();
  ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
}

function drawColorbar(ctx, x, y, width, height, min, max, label) {
  const gradient = ctx.createLinearGradient(0, y + height, 0, y);
  for (let i = 0; i <= 1; i += 0.05) gradient.addColorStop(i, colorFor(min + (max - min) * i, min, max));
  ctx.fillStyle = gradient; ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.strokeRect(x, y, width, height);
  ctx.fillStyle = '#dceeff'; ctx.font = '12px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (let i=0; i<=4; i++) {
    const yy = y + height * i / 4; const val = max - (max - min) * i / 4;
    ctx.fillText(format(val, 3), x + width + 8, yy);
  }
  ctx.save(); ctx.translate(x + width + 54, y + height / 2); ctx.rotate(-Math.PI/2); ctx.textAlign = 'center'; ctx.fillText(label, 0, 0); ctx.restore();
}

function drawLegend(ctx, x, y, items) {
  ctx.save();
  ctx.font = '12px system-ui';
  const width = Math.max(...items.map(item => ctx.measureText(item.label).width)) + 42;
  const height = 12 + items.length * 20;
  ctx.fillStyle = 'rgba(7,16,29,.82)'; ctx.strokeStyle = 'rgba(255,255,255,.22)';
  ctx.fillRect(x, y, width, height); ctx.strokeRect(x, y, width, height);
  items.forEach((item, i) => {
    const yy = y + 17 + i * 20;
    ctx.strokeStyle = item.color; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x + 10, yy); ctx.lineTo(x + 30, yy); ctx.stroke();
    ctx.fillStyle = '#eef6ff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(item.label, x + 36, yy);
  });
  ctx.restore();
}

function interpolateTick(values, fraction) {
  if (!values.length) return 0;
  return Math.min(...values) + (Math.max(...values) - Math.min(...values)) * fraction;
}

function labelForParam(param) {
  const spec = controls.find(([key]) => key === param);
  return spec ? `${spec[1]}${spec[2] ? ` (${spec[2]})` : ''}` : param;
}

function labelForMetric(metric) {
  const spec = sweepMetrics.find(([key]) => key === metric);
  return spec ? spec[1] : metric;
}

function exportSweep() {
  const sweep = window.currentSweep;
  if (!sweep) return;
  const metricKeys = sweepMetrics.map(([key]) => key).concat('dominantBlur');
  const headers = [sweep.xParam, sweep.yParam || 'sweepIndex', ...metricKeys];
  const lines = [headers.join(',')];
  sweep.rows.forEach((row, i) => {
    const yi = Math.floor(i / sweep.xValues.length);
    lines.push([row[sweep.xParam], sweep.yParam ? row[sweep.yParam] : yi, ...metricKeys.map(k => row[k])].join(','));
  });
  downloadText('mini-mbe-sweep-results.csv', lines.join('\n'), 'text/csv');
}
