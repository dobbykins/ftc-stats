// ═══════════════════════════════════════════════════════════
// EPA ENGINE — matches reference index.html exactly
// ═══════════════════════════════════════════════════════════

// K-factor shape
const K_RAMP_START   = 2;
const K_RAMP_END     = 5;
const K_PEAK_VAL     = 0.35;
const K_FLOOR        = 0.65;

const AUTO_PRIOR_FRAC    = 0.15;
const PATTERN_PRIOR_FRAC = 0.0;
const PARK_PRIOR_FRAC    = 0.0;

const REGION_EARLY_EVENTS  = 4;
const REGION_FALLBACK_FRAC = 0.96;
const GLOBAL_FALLBACK_FRAC = 1.00;
const PRIOR_SEASON_WEIGHT  = 0.6;

const AUTO_STABILITY_WINDOW = 0.25;
const AUTO_STABILITY_FLOOR  = 0.60;

const MOMENTUM_WINDOW      = 0;
const MOMENTUM_WEIGHT      = 0;
const ELO_SCALE_MULTIPLIER = 1.0;

// 0 = include all matches in accuracy (reference sets both to 0)
const MIN_MATCHES_FOR_PRED = 0;
const EPA_TRUST_RAMP_END   = 0;

// ── Math helpers ──────────────────────────────────────────
export const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
const variance = arr => {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return mean(arr.map(x => (x - m) ** 2));
};
export const toU = (epa, avg) => avg ? epa / avg : 0;

export function mFactor(n)
{
  if (n <= 10)         return 0.2;
  else if (n <= 18)    return 0.2 + (0.8 / 8) * (n - 10);
  else                 return 1;
}
export function kFactor(n) {
  if (n <= K_RAMP_START)  return K_FLOOR;
  else if (n > K_RAMP_START && n <= K_RAMP_END)    return K_FLOOR + (K_FLOOR - K_PEAK_VAL) * (n - K_RAMP_START) / (K_RAMP_END - K_RAMP_START);
  else  return K_PEAK_VAL;
}

function epaUpdate(k, m, scoreShare, myEpa, oppShare, oppEpa) {
  return k * (1 / (1 + m)) * ((scoreShare - myEpa) - m * (oppShare - oppEpa));
}

export function uepaLabel(u) {
  if (u >= 2.0) return 'Elite';
  if (u >= 1.5) return 'Strong';
  if (u >= 1.1) return 'Above Avg';
  if (u >= 0.9) return 'Average';
  if (u >= 0.6) return 'Below Avg';
  return 'Developing';
}

// ── Region utilities ──────────────────────────────────────
function extractRegion(code) {
  if (!code || code.length < 2) return 'OTHER';
  const u = code.toUpperCase();
  const p2 = u.slice(0, 2);
  if (p2 === 'US' || p2 === 'CA') return u.slice(0, 4);
  if (u.startsWith('FTCCMP') || u.startsWith('USACMP')) return 'CMP';
  return p2;
}

function buildRegionalPriors(rows) {
  const eventRegion = {}, eventFirstTime = {};
  for (const r of rows) {
    const ev = (r.event || '').toUpperCase();
    if (!ev || ev === 'LIVE' || ev === 'DIRECT') continue;
    if (!eventRegion[ev]) eventRegion[ev] = extractRegion(ev);
    const t = r.mt || '';
    if (t && (!eventFirstTime[ev] || t < eventFirstTime[ev])) eventFirstTime[ev] = t;
  }

  const regionEvents = {};
  for (const [ev, region] of Object.entries(eventRegion)) {
    if (region === 'CMP') continue;
    if (!regionEvents[region]) regionEvents[region] = [];
    regionEvents[region].push(ev);
  }
  for (const region of Object.keys(regionEvents)) {
    regionEvents[region].sort((a, b) =>
      (eventFirstTime[a] || 'z').localeCompare(eventFirstTime[b] || 'z')
    );
  }

  const regionEarlyAvg = {};
  for (const [region, events] of Object.entries(regionEvents)) {
    const earlyEvents = new Set(events.slice(0, REGION_EARLY_EVENTS));
    const perRobot = [];
    for (const r of rows) {
      const ev = (r.event || '').toUpperCase();
      if (!earlyEvents.has(ev)) continue;
      // only qual matches for regional prior (matches reference guard)
      if (r.rt?.length) perRobot.push(r.rs / r.rt.length);
      if (r.bt?.length) perRobot.push(r.bs / r.bt.length);
    }
    if (perRobot.length >= 4) regionEarlyAvg[region] = mean(perRobot);
  }

  const teamFirstEvent = {}, teamFirstTime = {};
  for (const r of rows) {
    const ev = (r.event || '').toUpperCase();
    if (!ev || ev === 'LIVE') continue;
    const t = r.mt || '';
    for (const team of [...(r.rt || []), ...(r.bt || [])]) {
      if (!teamFirstTime[team] || (t && t < teamFirstTime[team])) {
        teamFirstTime[team] = t;
        teamFirstEvent[team] = ev;
      }
    }
  }

  const teamRegion = {};
  for (const [team, ev] of Object.entries(teamFirstEvent)) teamRegion[team] = extractRegion(ev);

  return { regionEarlyAvg, teamRegion };
}

// ── Shrinkage — with MIN=0 and END=0, shrinkEpa returns epa unchanged
function shrinkEpa(epa, matchCount, fallback) {
  if (matchCount >= EPA_TRUST_RAMP_END) return epa;
  if (matchCount < MIN_MATCHES_FOR_PRED) return fallback;
  const trust = (matchCount - MIN_MATCHES_FOR_PRED) / (EPA_TRUST_RAMP_END - MIN_MATCHES_FOR_PRED);
  return trust * epa + (1 - trust) * fallback;
}

function shrunkEpaMap(snap, mcSnap, seasonAvg, teamRegion, regionEarlyAvg) {
  const out = {};
  for (const [t, epa] of Object.entries(snap)) {
    const n = mcSnap[t] || 0;
    const region = teamRegion?.[+t];
    const fb = (region && regionEarlyAvg?.[region])
      ? regionEarlyAvg[region] * REGION_FALLBACK_FRAC
      : seasonAvg * GLOBAL_FALLBACK_FRAC;
    out[t] = shrinkEpa(epa, n, fb);
  }
  return out;
}

// ── Main EPA build ─────────────────────────────────────────
export function buildEpa(rows, priorRatings = {}) {
  const ratings = {}, autoR = {}, dcR = {}, mc = {};
  const patR = {}, parkR = {};
  const autoHistory = {};
  const recentMatchScores = {};
  const opponentHistory = {};

  const perRobot = [];
  for (const r of rows) {
    if (r.rt?.length) perRobot.push(r.rs / r.rt.length);
    if (r.bt?.length) perRobot.push(r.bs / r.bt.length);
  }
  const seasonAvg = perRobot.length ? mean(perRobot) : 30;

  const margins = [];
  for (const r of rows) {
    if (r.rs !== undefined && r.bs !== undefined && r.rs !== r.bs)
      margins.push(Math.abs(r.rs - r.bs));
  }
  const eloScale = margins.length > 10
    ? [...margins].sort((a, b) => a - b)[Math.floor(margins.length * 0.65)]
    : seasonAvg * ELO_SCALE_MULTIPLIER;

  const { regionEarlyAvg, teamRegion } = buildRegionalPriors(rows);

  const isCareer = priorRatings._isCareer === true;
  const careerPrior = isCareer ? priorRatings.careerPrior : null;
  const priorSeasonValues = !isCareer ? Object.values(priorRatings) : [];
  const priorSeasonAvg = priorSeasonValues.length ? mean(priorSeasonValues) : 0;

  const initEpa = (team) => {
    const region = teamRegion[team];
    const regionalPrior = (region && regionEarlyAvg[region])
      ? regionEarlyAvg[region] * REGION_FALLBACK_FRAC
      : seasonAvg * GLOBAL_FALLBACK_FRAC;
    if (isCareer && careerPrior?.[team] !== undefined) {
      const scaledPrior = careerPrior[team] * seasonAvg;
      return PRIOR_SEASON_WEIGHT * scaledPrior + (1 - PRIOR_SEASON_WEIGHT) * regionalPrior;
    }
    if (!isCareer) {
      const priorRaw = priorRatings[team];
      if (priorRaw !== undefined && priorSeasonAvg > 0) {
        const scaledPrior = priorRaw * (seasonAvg / priorSeasonAvg);
        return PRIOR_SEASON_WEIGHT * scaledPrior + (1 - PRIOR_SEASON_WEIGHT) * regionalPrior;
      }
    }
    return regionalPrior;
  };

  const allTeams = new Set();
  for (const r of rows) [...(r.rt || []), ...(r.bt || [])].forEach(t => allTeams.add(t));

  for (const t of allTeams) {
    const init = initEpa(t);
    ratings[t] = init;
    autoR[t]   = init * AUTO_PRIOR_FRAC;
    dcR[t]     = init - autoR[t];
    patR[t]    = init * PATTERN_PRIOR_FRAC;
    parkR[t]   = init * PARK_PRIOR_FRAC;
    mc[t] = 0;
    autoHistory[t]       = [];
    recentMatchScores[t] = [];
    opponentHistory[t]   = [];
  }

  const mcEvent = {}, teamCurEvent = {};
  const preEventEpas = {}, seenAtEvent = new Set();
  const chronoSnapshots = [];

  const sorted = [...rows].sort((a, b) => (a.mt || '').localeCompare(b.mt || ''));

  for (const row of sorted) {
    const { rt: red, bt: blue } = row;
    if (!red?.length || !blue?.length) continue;

    const ev = (row.event || '').toUpperCase();
    if (ev && ev !== 'LIVE') {
      if (!preEventEpas[ev]) preEventEpas[ev] = {};
      for (const t of [...red, ...blue]) {
        if (!seenAtEvent.has(`${ev}_${t}`)) {
          seenAtEvent.add(`${ev}_${t}`);
          preEventEpas[ev][t] = ratings[t] ?? initEpa(t);
          if (teamCurEvent[t] !== ev) { teamCurEvent[t] = ev; mcEvent[t] = 0; }
        }
      }
    }

    if (row.rtot !== undefined && row.rtot !== null && row.rtot !== row.btot) {
      const snap = {}, mcSnap = {};
      for (const t of [...red, ...blue]) {
        snap[t]   = ratings[t] ?? initEpa(t);
        mcSnap[t] = mc[t] || 0;
      }
      chronoSnapshots.push({ row, snap, mcSnap });
    }

    if (row.rtot == null || row.btot == null || row.rtot === row.btot) {
      for (const t of [...red, ...blue]) {
        mc[t] = (mc[t] || 0) + 1;
        mcEvent[t] = (mcEvent[t] || 0) + 1;
      }
      continue;
    }

    const nr = 2, nb = 2;
    const rShare = row.rs / nr, bShare = row.bs / nb;
    const rAutoShares = red.map(() => (row.ra || 0) / nr);
    const bAutoShares = blue.map(() => (row.ba || 0) / nb);
    const rPatShare  = (row.rPatPts  ?? 0) / nr, bPatShare  = (row.bPatPts  ?? 0) / nb;
    const rParkShare = (row.rParkPts ?? 0) / nr, bParkShare = (row.bParkPts ?? 0) / nb;

    const rEA = mean(red.map(t => ratings[t] ?? initEpa(t)));
    const bEA = mean(blue.map(t => ratings[t] ?? initEpa(t)));

    for (const t of red)  opponentHistory[t].push(mean(blue.map(tt => ratings[tt] ?? initEpa(tt))));
    for (const t of blue) opponentHistory[t].push(mean(red.map(tt  => ratings[tt] ?? initEpa(tt))));

    for (const t of red) {
      const k = kFactor(mcEvent[t] || 0);
      const m = mFactor(mcEvent[t] || 0);
      const myEpa = ratings[t] ?? initEpa(t);
      ratings[t] = myEpa + epaUpdate(k, m, rShare, myEpa, bShare, bEA);
    }
    for (const t of blue) {
      const k = kFactor(mcEvent[t] || 0);
      const m = mFactor(mcEvent[t] || 0);
      const myEpa = ratings[t] ?? initEpa(t);
      ratings[t] = myEpa + epaUpdate(k, m, bShare, myEpa, rShare, rEA);
    }

    for (const t of red) {
      recentMatchScores[t].push(rShare);
      if (recentMatchScores[t].length > MOMENTUM_WINDOW) recentMatchScores[t].shift();
    }
    for (const t of blue) {
      recentMatchScores[t].push(bShare);
      if (recentMatchScores[t].length > MOMENTUM_WINDOW) recentMatchScores[t].shift();
    }

    for (let i = 0; i < red.length; i++) {
      const t = red[i];
      const k = kFactor(mcEvent[t] || 0);
      const myAutoEpa = autoR[t] ?? initEpa(t) * AUTO_PRIOR_FRAC;
      autoR[t] = Math.min((autoR[t] ?? 0) + k * (rAutoShares[i] - myAutoEpa), ratings[t]);
      autoHistory[t].push(rAutoShares[i]);
    }
    for (let i = 0; i < blue.length; i++) {
      const t = blue[i];
      const k = kFactor(mcEvent[t] || 0);
      const myAutoEpa = autoR[t] ?? initEpa(t) * AUTO_PRIOR_FRAC;
      autoR[t] = Math.min((autoR[t] ?? 0) + k * (bAutoShares[i] - myAutoEpa), ratings[t]);
      autoHistory[t].push(bAutoShares[i]);
    }

    for (const t of red) {
      const k = kFactor(mcEvent[t] || 0);
      if (rPatShare > 0 || row.rPatPts !== undefined)
        patR[t] = Math.max(0, (patR[t] ?? 0) + k * (rPatShare - (patR[t] ?? 0)));
      if (rParkShare > 0 || row.rParkPts !== undefined)
        parkR[t] = Math.max(0, (parkR[t] ?? 0) + k * (rParkShare - (parkR[t] ?? 0)));
    }
    for (const t of blue) {
      const k = kFactor(mcEvent[t] || 0);
      if (bPatShare > 0 || row.bPatPts !== undefined)
        patR[t] = Math.max(0, (patR[t] ?? 0) + k * (bPatShare - (patR[t] ?? 0)));
      if (bParkShare > 0 || row.bParkPts !== undefined)
        parkR[t] = Math.max(0, (parkR[t] ?? 0) + k * (bParkShare - (parkR[t] ?? 0)));
    }

    // dcR is always derived (matches reference exactly)
    for (const t of [...red, ...blue]) {
      dcR[t] = (ratings[t] || 0) - (autoR[t] || 0);
      mc[t]  = (mc[t] || 0) + 1;
      mcEvent[t] = (mcEvent[t] || 0) + 1;
    }
  }

  const momentumEpa = {};
  for (const t of allTeams) {
    const recent = recentMatchScores[t] || [];
    if (recent.length >= 2) {
      let ws = 0, wt = 0;
      for (let i = 0; i < recent.length; i++) { const w = i + 1; ws += recent[i] * w; wt += w; }
      momentumEpa[t] = wt > 0 ? ws / wt : ratings[t];
    } else {
      momentumEpa[t] = ratings[t];
    }
  }

  const scheduleStrength = {};
  for (const t of allTeams) {
    const hist = opponentHistory[t] || [];
    if (hist.length >= 2) scheduleStrength[t] = mean(hist);
  }

  const initialEpas = {};
  for (const t of allTeams) initialEpas[t] = initEpa(t);

  return {
    ratings, autoRatings: autoR, dcRatings: dcR,
    patternRatings: patR, parkRatings: parkR,
    matchCounts: mc, seasonAvg,
    initialEpas, preEventEpas, chronoSnapshots,
    fallback: seasonAvg * GLOBAL_FALLBACK_FRAC,
    regionEarlyAvg, teamRegion,
    autoHistory, momentumEpa, 
    scheduleStrength, eloScale,
  };
}

// ── Win probability ────────────────────────────────────────
export function epaWinProb(redTeams, blueTeams, state) {
  const {
    ratings, momentumEpa, matchCounts, autoRatings,
    seasonAvg, eloScale, teamRegion, regionEarlyAvg,
  } = state;

  const regionalFallback = (t) => {
    const region = teamRegion?.[t];
    return (region && regionEarlyAvg?.[region])
      ? regionEarlyAvg[region] * REGION_FALLBACK_FRAC
      : (seasonAvg || 30) * GLOBAL_FALLBACK_FRAC;
  };

  const predictionEpa = (t) => {
    const rawEpa = ratings[t] ?? regionalFallback(t);
    const momEpa = momentumEpa?.[t];
    if (momEpa !== undefined && (matchCounts?.[t] ?? 0) >= MOMENTUM_WINDOW)
      return rawEpa * (1 - MOMENTUM_WEIGHT) + momEpa * MOMENTUM_WEIGHT;
    return rawEpa;
  };

  const teamScore = (t) => {
    const epa  = Math.max(0, predictionEpa(t));
    const aepa = autoRatings?.[t] ?? epa * AUTO_PRIOR_FRAC;
    const dcEpa = Math.max(0, epa - aepa);
    return Math.max(0, epa);
  };

  const rSum = redTeams.reduce((s, t) => s + teamScore(t), 0);
  const bSum = blueTeams.reduce((s, t) => s + teamScore(t), 0);

  const scale = Math.max(eloScale || (seasonAvg || 30) * ELO_SCALE_MULTIPLIER, 1);
  const d = bSum - rSum; // direct diff — NO 400/scale factor
  return Math.max(0, Math.min(1, 1 / (1 + Math.pow(10, d / scale))));
}

// ── Season accuracy ────────────────────────────────────────
// CRITICAL: matches reference behaviour exactly.
// Reference epaWinProb reads ST.autoRatings/momentumEpa/matchCounts from FINAL
// global state — NOT from the snapshot. Only the ratings map uses snapshot values.
export function computeSeasonAccuracy(chronoSnapshots, state) {
  let correct = 0, total = 0;

  for (const { row, snap, mcSnap } of chronoSnapshots) {
    if (row.rtot == null || row.rtot === row.btot) continue;

    const allTeams = [...row.rt, ...row.bt];
    const minMc = Math.min(...allTeams.map(t => mcSnap?.[t] || 0));
    if (minMc < MIN_MATCHES_FOR_PRED) continue;

    // Shrink snapshot EPAs with regional fallback
    const shrunkSnap = shrunkEpaMap(snap, mcSnap, state.seasonAvg, state.teamRegion, state.regionEarlyAvg);

    // Pass final-state for autoRatings/momentumEpa/matchCounts/autoStability
    // but substitute the shrunk snapshot as the ratings map
    const predState = {
      ...state,
      ratings: shrunkSnap,
    };

    const rwp  = epaWinProb(row.rt, row.bt, predState);
    const pred   = rwp > 0.5 ? 'red' : 'blue';
    const actual = row.rtot > row.btot ? 'red' : 'blue';
    if (pred === actual) correct++;
    total++;
  }

  return total > 0 ? { correct, total, pct: Math.round(correct / total * 100) } : null;
}

// ── getStats helper ────────────────────────────────────────
export function getStats(team, state) {
  const epa = state.ratings[team];
  if (epa === undefined || epa === null) return null;
  const aepa = state.autoRatings[team] ?? epa * AUTO_PRIOR_FRAC;
  const dc   = state.dcRatings[team]   ?? epa - aepa;
  const init = state.initialEpas[team] ?? state.fallback;
  const u    = toU(epa, state.seasonAvg);
  return {
    team, epa, auto_epa: aepa, teleop_epa: dc,
    uepa: u, uepa_label: uepaLabel(u),
    matches: state.matchCounts[team] || 0,
    trend: epa - init,
    momentum_epa: state.momentumEpa[team] ?? epa,
    schedule_strength: state.scheduleStrength[team],
  };
}

// ── parseMatchRow ──────────────────────────────────────────
export function parseMatchRow(season, m, scoreDetail, eventCode, level) {
  try {
    const code = (eventCode || '').toUpperCase();
    if (!code) return null;
    if (m.scoreRedFinal == null || m.scoreBlueFinal == null) return null;
    const teams = m.teams || [];
    const rt = teams.filter(t => (t.station || '').startsWith('Red')  && !t.surrogate && !t.noShow).map(t => t.teamNumber);
    const bt = teams.filter(t => (t.station || '').startsWith('Blue') && !t.surrogate && !t.noShow).map(t => t.teamNumber);
    if (!rt.length || !bt.length) return null;
    const redT = +(m.scoreRedFinal || 0), bluT = +(m.scoreBlueFinal || 0);
    const redA = +(m.scoreRedAuto  || 0), bluA = +(m.scoreBlueAuto  || 0);
    const alliances = (scoreDetail?.alliances) || [];
    const rsc = alliances.find(a => a.alliance === 'Red')  || {};
    const bsc = alliances.find(a => a.alliance === 'Blue') || {};
    const redF = +(rsc.foulPoints ?? m.scoreRedFoul  ?? 0);
    const bluF = +(bsc.foulPoints ?? m.scoreBlueFoul ?? 0);
    return {
      season, event: code, match: `${code}-Q${m.matchNumber}`, rt, bt,
      rs: Math.max(0, redT - bluF),
      bs: Math.max(0, bluT - redF),
      ra: Math.min(redA, Math.max(0, redT - bluF)),
      ba: Math.min(bluA, Math.max(0, bluT - redF)),
      rtot: redT, btot: bluT, rf: redF, bf: bluF,
      won: redT > bluT ? 1 : 0,
      mt: m.actualStartTime || m.startTime || '',
      level, matchNum: m.matchNumber,
      rPatPts:  +(rsc.patternPoints ?? rsc.patternBonusPoints ?? 0),
      bPatPts:  +(bsc.patternPoints ?? bsc.patternBonusPoints ?? 0),
      rParkPts: +(rsc.parkPoints ?? rsc.endgameParkPoints ?? rsc.ascent1Points ?? rsc.ascentPoints ?? 0),
      bParkPts: +(bsc.parkPoints ?? bsc.endgameParkPoints ?? bsc.ascent1Points ?? bsc.ascentPoints ?? 0),
      rNavPts:  +(rsc.autoNavigationPoints ?? rsc.autoNavPoints ?? 0),
      bNavPts:  +(bsc.autoNavigationPoints ?? bsc.autoNavPoints ?? 0),
      rSampPts: +(rsc.autoSamplePoints ?? rsc.autoSpecimenPoints ?? 0),
      bSampPts: +(bsc.autoSamplePoints ?? bsc.autoSpecimenPoints ?? 0),
      rMovRP: rsc.movementRankingPoint ? 1 : 0,
      bMovRP: bsc.movementRankingPoint ? 1 : 0,
      rGoalRP: rsc.goalRankingPoint    ? 1 : 0,
      bGoalRP: bsc.goalRankingPoint    ? 1 : 0,
      rPatRP:  rsc.patternRankingPoint ? 1 : 0,
      bPatRP:  bsc.patternRankingPoint ? 1 : 0,
    };
  } catch (e) { return null; }
}