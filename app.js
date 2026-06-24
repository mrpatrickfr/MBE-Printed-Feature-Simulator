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
  ['substrateTemp', 'Substrate temperature', '°C', 20, 500, 1, 'Controls thermally activated surface diffusion.'],
  ['sourceTemp', 'Source temperature', '°C', 900, 1300, 5, 'Affects flux weighting weakly here once deposition rate is fixed.'],
  ['depositionTime', 'Residence / deposition time', 's', 1, 300, 1, 'Effective time available for adatoms to diffuse before burial or desorption.'],
  ['sticking', 'Sticking coefficient', '', 0.1, 1, 0.01, 'Scales thickness; low sticking slightly increases effective diffusion distance.']
];

const controlsEl = document.getElementById('controls');
function buildControls() {
  controlsEl.innerHTML = `<div class="control"><label for="material">Substrate material</label><small>Preset Arrhenius parameters for Al adatom mobility.</small><select id="material">${Object.entries(presets).map(([k,v]) => `<option value="${k}">${v.label}</option>`).join('')}</select></div>`;
  for (const [key, label, unit, min, max, step, help] of controls) {
    controlsEl.insertAdjacentHTML('beforeend', `<div class="control"><label for="${key}"><span>${label}</span><output id="${key}Out"></output></label><small>${help}</small><input id="${key}" type="range" min="${min}" max="${max}" step="${step}" /></div>`);
  }
  document.getElementById('material').addEventListener('change', e => { state.material = e.target.value; simulate(); });
  for (const [key] of controls) document.getElementById(key).addEventListener('input', e => { state[key] = Number(e.target.value); simulate(); });
}

function syncControls() {
  document.getElementById('material').value = state.material;
  for (const [key,,unit] of controls) {
    document.getElementById(key).value = state[key];
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
  const img = ctx.createImageData(w,h), maxR = Math.min(w,h)*0.43;
  for (let y=0; y<h; y++) for (let x=0; x<w; x++) {
    const dx=(x-w/2)/maxR, dy=(y-h/2)/maxR;
    const rUm = Math.hypot(dx,dy) * Math.max(state.maskDiameter, 30);
    const val = radialValue(rUm, profile.sigma, state.maskDiameter/2);
    const i=(y*w+x)*4; img.data[i]=20+235*val; img.data[i+1]=45+150*Math.sqrt(val); img.data[i+2]=80+110*(1-val); img.data[i+3]=255;
  }
  ctx.putImageData(img,0,0);
  ctx.strokeStyle='rgba(255,255,255,.55)'; ctx.setLineDash([6,6]); ctx.lineWidth=2; ctx.beginPath(); ctx.arc(w/2,h/2,maxR*0.5,0,Math.PI*2); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle='white'; ctx.font='16px system-ui'; ctx.fillText('Dashed ring: nominal mask aperture', 22, 32);
}
function radialValue(r, sigma, radius) { return Math.max(0, Math.min(1, 0.5*(1-erf((r-radius)/(Math.SQRT2*sigma))))); }

function drawProfile(profile) {
  const c = document.getElementById('profile'), ctx = c.getContext('2d'), w = c.width, h = c.height, pad=42;
  ctx.clearRect(0,0,w,h); ctx.strokeStyle='rgba(255,255,255,.16)'; ctx.lineWidth=1;
  for(let i=0;i<=4;i++){ const y=pad+(h-2*pad)*i/4; ctx.beginPath(); ctx.moveTo(pad,y); ctx.lineTo(w-pad,y); ctx.stroke(); }
  const xmin=profile.xs[0], xmax=profile.xs.at(-1);
  ctx.strokeStyle='#66e3ff'; ctx.lineWidth=3; ctx.beginPath();
  profile.xs.forEach((x,i)=>{ const px=pad+(x-xmin)/(xmax-xmin)*(w-2*pad), py=h-pad-profile.ys[i]*(h-2*pad); i?ctx.lineTo(px,py):ctx.moveTo(px,py); }); ctx.stroke();
  ctx.fillStyle='#dceeff'; ctx.font='14px system-ui'; ctx.fillText('centerline height profile', pad, 22); ctx.fillText('position (µm)', w/2-40, h-10); ctx.save(); ctx.translate(14,h/2+35); ctx.rotate(-Math.PI/2); ctx.fillText('normalized thickness',0,0); ctx.restore();
}

function simulate() {
  syncControls();
  const p = simulateProfile(), m = metrics(p);
  drawMorphology(p); drawProfile(p);
  const dominant = p.geomSigma > p.diffSigma * 1.15 ? 'Geometry' : p.diffSigma > p.geomSigma * 1.15 ? 'Diffusion' : 'Mixed';
  document.getElementById('dominantBlur').textContent = dominant;
  document.getElementById('dominantNote').textContent = dominant === 'Geometry' ? 'Reduce mask-substrate gap or source diameter' : dominant === 'Diffusion' ? 'Lower substrate temperature or residence time' : 'Both effects are comparable';
  document.getElementById('fwhm').textContent = `${format(m.fwhm,3)} µm`;
  document.getElementById('edgeWidth').textContent = `${format(m.edge,3)} µm`;
  document.getElementById('geomSigma').textContent = `${format(p.geomSigma,3)} µm`;
  document.getElementById('diffSigma').textContent = `${format(p.diffSigma,3)} µm`;
  document.getElementById('totalSigma').textContent = `${format(p.sigma,3)} µm`;
  document.getElementById('diffCoeff').textContent = `${p.D.toExponential(2)} m²/s`;
  window.currentProfile = p;
}

function erf(x) { const s=Math.sign(x); x=Math.abs(x); const a1=.254829592,a2=-.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=.3275911; const t=1/(1+p*x); return s*(1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x)); }
function format(v, sig=3) { return Number(v).toLocaleString(undefined, { maximumSignificantDigits: sig }); }

document.getElementById('resetBtn').addEventListener('click', () => { state = { ...defaults }; simulate(); });
document.getElementById('exportBtn').addEventListener('click', () => {
  const p = window.currentProfile; if (!p) return;
  const csv = 'x_um,normalized_thickness\n' + p.xs.map((x,i)=>`${x},${p.ys[i]}`).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'})); a.download = 'mini-mbe-profile.csv'; a.click(); URL.revokeObjectURL(a.href);
});

buildControls(); simulate();
