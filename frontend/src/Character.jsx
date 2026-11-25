import { useEffect, useRef } from "react";

/*
 * Maya, the receptionist: a hand-built SVG scene driven by a requestAnimationFrame loop.
 * React renders the markup once; the loop writes attributes straight to the elements (no re-renders).
 *
 *   levels: ref {user, bot}  mic levels, 0..1
 *   info:   ref {phase, stage, awaiting}  what the call is doing
 *   onMood: called when the scene changes (used for the caption under the scene)
 */

const SKIN = "#C68F6B", SKIN_D = "#AF7A59", HAIR = "#231C1A", INK = "#1C2420";
const GREEN = "#0F5C4A", GREEN_D = "#0B4637", CREAM = "#F4EFE4", LIP = "#8A3A33";
const CONFETTI = ["#0F5C4A", "#C2492F", "#E8B04B", "#7FB89A", "#F4EFE4", "#3A6FD8"];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, k) => a + (b - a) * k;
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

// Shoulders, resting/typing hand spots, ear position and the cradle for the handset.
const SH_R = [84, 300], SH_L = [196, 300];
const REST_R = [112, 410], GRIP = [61, 360], EAR = [84, 222];
const KEYS = [160, 418];

// Pose presets. smile -1..1, brow -1..1 (raised), sad 0..1, happy 0..1, look = eye direction.
const POSE = {
  ringing: { smile: 0.25, brow: 0.35, sad: 0, happy: 0, blush: 0, look: [-1, 0.4], tilt: 0, type: 0, slump: 0, screen: "idle" },
  idle: { smile: 0.55, brow: 0.1, sad: 0, happy: 0, blush: 0.1, look: [0, 0], tilt: 0, type: 0, slump: 0, screen: "idle" },
  listening: { smile: 0.4, brow: 0.3, sad: 0, happy: 0, blush: 0.1, look: [0, 0], tilt: -3.5, type: 0, slump: 0, screen: "idle" },
  speaking: { smile: 0.5, brow: 0.2, sad: 0, happy: 0, blush: 0.12, look: [0, 0], tilt: 1.5, type: 0, slump: 0, screen: "idle" },
  thinking: { smile: 0.05, brow: 0.55, sad: 0, happy: 0, blush: 0, look: [0.8, -0.9], tilt: 3.5, type: 0, slump: 0, screen: "idle" },
  searching: { smile: 0.1, brow: 0.05, sad: 0, happy: 0, blush: 0, look: [1, 0.7], tilt: 4, type: 1, slump: 0, screen: "search" },
  found: { smile: 1, brow: 0.75, sad: 0, happy: 1, blush: 0.7, look: [0.6, 0.4], tilt: 2, type: 0, slump: 0, screen: "found" },
  notfound: { smile: -0.35, brow: 0.2, sad: 0.8, happy: 0, blush: 0, look: [0.7, 0.8], tilt: 4, type: 0, slump: 1, screen: "notfound" },
  booking: { smile: 0.2, brow: 0.1, sad: 0, happy: 0, blush: 0, look: [1, 0.7], tilt: 4, type: 1, slump: 0, screen: "book" },
  booked: { smile: 1, brow: 0.75, sad: 0, happy: 1, blush: 0.7, look: [0.5, 0.3], tilt: 2, type: 0, slump: 0, screen: "booked" },
  cancelling: { smile: 0.05, brow: 0, sad: 0.15, happy: 0, blush: 0, look: [1, 0.7], tilt: 4, type: 1, slump: 0, screen: "cancel" },
  cancelled: { smile: 0.35, brow: 0.2, sad: 0.35, happy: 0, blush: 0, look: [0.5, 0.4], tilt: 3, type: 0, slump: 0.4, screen: "cancelled" },
  failed: { smile: -0.35, brow: 0.2, sad: 0.8, happy: 0, blush: 0, look: [0.7, 0.8], tilt: 4, type: 0, slump: 1, screen: "failed" },
  ended: { smile: 0.7, brow: 0.2, sad: 0, happy: 0.25, blush: 0.2, look: [0, 0], tilt: 0, type: 0, slump: 0, screen: "idle" },
};
const SCREENS = ["idle", "search", "found", "notfound", "book", "booked", "cancel", "cancelled", "failed"];

function pickMood({ phase, stage, awaiting }, { user, bot }) {
  if (phase === "ended") return "ended";
  if (phase === "connecting") return "ringing";
  if (stage) {
    const { kind, status } = stage;
    if (status === "working") return kind === "check" ? "searching" : kind === "book" ? "booking" : "cancelling";
    if (status === "failed") return kind === "check" ? "notfound" : "failed";
    return kind === "check" ? "found" : kind === "book" ? "booked" : "cancelled";
  }
  if (bot > 0.03) return "speaking";
  if (user > 0.04) return "listening";
  if (awaiting) return "thinking";
  return "idle";
}

export default function Character({ levels, info, onMood }) {
  const R = useRef({});
  const ref = (n) => (el) => (R.current[n] = el);

  useEffect(() => {
    const e = R.current;
    const set = (n, attrs) => {
      const el = e[n];
      if (!el) return;
      for (const k in attrs) el.setAttribute(k, attrs[k]);
    };
    const S = {
      smile: 0.5, brow: 0, sad: 0, happy: 0, blush: 0, lx: 0, ly: 0, tilt: 0, slump: 0, type: 0,
      mouth: 0, pick: info.current.instant && info.current.phase === "connected" ? 1 : 0, wave: 0, hop: 0, screen: Object.fromEntries(SCREENS.map((s) => [s, s === "idle" ? 1 : 0])),
      t: 0, blinkAt: 2, blink: 0,
    };
    const parts = Array.from({ length: 36 }, () => ({ life: 0 }));
    let mood = "", last = performance.now(), raf;

    const burst = (n, ox, oy, spread = 1) => {
      let made = 0;
      for (const p of parts) {
        if (p.life > 0 || made >= n) continue;
        Object.assign(p, {
          x: ox, y: oy, vx: (Math.random() - 0.5) * 220 * spread, vy: -120 - Math.random() * 190,
          r: Math.random() * 360, vr: (Math.random() - 0.5) * 720, life: 1.4 + Math.random() * 0.6,
          c: CONFETTI[(Math.random() * CONFETTI.length) | 0], w: 5 + Math.random() * 4,
        });
        made++;
      }
    };

    const arm = (name, sh, hand, side, restHand, mid = 0.2) => {
      // Elbow hangs low and outside the shoulder, drifting slightly toward the hand.
      const ex = sh[0] + side * 26 + (hand[0] - restHand[0]) * mid;
      const ey = sh[1] + 84 + (hand[1] - restHand[1]) * mid;
      set(name, { d: `M${sh[0]} ${sh[1]} L${ex} ${ey} L${hand[0]} ${hand[1]}` });
    };

    const frame = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      S.t += dt;
      const { phase } = info.current;
      const lv = levels.current;
      const m = pickMood(info.current, lv);
      if (m !== mood) {
        mood = m;
        onMood?.(m);
        if (m === "found") burst(10, 290, 240, 0.8);
        if (m === "booked") {
          burst(18, 290, 232, 1.2);
          burst(14, 140, 40, 1.6);
        }
        if (m === "cancelled" || m === "ended") burst(0, 0, 0);
        S.hop = m === "found" || m === "booked" ? 1 : S.hop;
      }
      const P = POSE[m];
      const k = 1 - Math.exp(-dt * 6);
      for (const key of ["smile", "brow", "sad", "happy", "blush", "tilt", "type", "slump"]) S[key] = lerp(S[key], P[key], k);
      S.lx = lerp(S.lx, P.look[0], k);
      S.ly = lerp(S.ly, P.look[1], k);
      SCREENS.forEach((s) => (S.screen[s] = lerp(S.screen[s], P.screen === s ? 1 : 0, 1 - Math.exp(-dt * 9))));
      // mouth follows the agent's voice: quick attack, slower release
      const target = clamp(lv.bot * 5.5, 0, 1);
      S.mouth = lerp(S.mouth, target, target > S.mouth ? 0.55 : 0.18);
      S.hop = Math.max(0, S.hop - dt * 1.6);

      // blink
      if (S.t > S.blinkAt) {
        S.blink = 1;
        S.blinkAt = S.t + 2.2 + Math.random() * 3;
      }
      S.blink = Math.max(0, S.blink - dt * 7);
      const eyeY = 1 - Math.sin(S.blink * Math.PI) * 0.92;

      // handset pickup / return
      const goal = phase === "connected" ? 1 : 0;
      S.pick = clamp(S.pick + Math.sign(goal - S.pick) * dt / 1.15, 0, 1);
      if ((goal === 1 && S.pick > 1) || (goal === 0 && S.pick < 0)) S.pick = goal;
      const p = S.pick;
      let hand, hc, th;
      if (p < 0.3) {
        const u = ease(p / 0.3);
        hand = [lerp(REST_R[0], GRIP[0], u), lerp(REST_R[1], GRIP[1], u)];
        hc = GRIP;
        th = 90;
      } else {
        const u = ease((p - 0.3) / 0.7);
        hc = [lerp(GRIP[0], EAR[0], u), lerp(GRIP[1], EAR[1], u)];
        th = lerp(90, 8, u);
        hand = hc;
      }
      const ringing = phase === "connecting" && p === 0;
      const shake = ringing ? Math.sin(S.t * 46) * 2.2 : 0;
      set("handset", { transform: `translate(${hc[0] + shake} ${hc[1]}) rotate(${th + (ringing ? Math.sin(S.t * 46) * 3 : 0)})` });
      set("rings", { opacity: ringing ? 0.55 + 0.45 * Math.sin(S.t * 9) : 0 });
      set("handR", { transform: `translate(${hand[0]} ${hand[1]})` });
      arm("armR", SH_R, hand, -1, REST_R, 0.2);

      // left hand: typing, waving goodbye, or resting
      const typing = S.type;
      const waving = phase === "ended" ? 1 : 0;
      S.wave = lerp(S.wave, waving, 0.1);
      let lh = [lerp(214, KEYS[0] + 26 * Math.sin(S.t * 1.9), typing), lerp(424, KEYS[1] + 4 * Math.abs(Math.sin(S.t * 9)), typing)];
      lh = [lerp(lh[0], 246 + Math.sin(S.t * 9) * 9, S.wave), lerp(lh[1], 268 + Math.cos(S.t * 9) * 3, S.wave)];
      set("handL", { transform: `translate(${lh[0]} ${lh[1]})` });
      arm("armL", SH_L, lh, 1, [214, 424], 0.35);

      // body + head
      const hop = Math.abs(Math.sin((1 - S.hop) * Math.PI * 2)) * S.hop * 9;
      const breathe = Math.sin(S.t * 1.8) * 1.1;
      const speak = S.mouth * 1.6;
      set("body", { transform: `translate(0 ${S.slump * 5 - hop + breathe * 0.4})` });
      set("head", { transform: `translate(${S.lx * 2.5} ${S.slump * 4 - speak + breathe * 0.3}) rotate(${S.tilt + S.slump * 2} 140 270)` });
      set("face", { transform: `translate(${S.lx * 3.2} ${S.ly * 1.5})` });
      set("pupils", { transform: `translate(${S.lx * 2.8} ${S.ly * 2.2})` });
      const happyEyes = clamp(S.happy * 1.4, 0, 1);
      set("eyes", { opacity: 1 - happyEyes, transform: `translate(0 198) scale(1 ${eyeY}) translate(0 -198)` });
      set("eyesHappy", { opacity: happyEyes });

      // brows: raise + sad slant (inner ends up)
      const by = 181 - S.brow * 5 - S.sad * 1;
      const inner = -S.sad * 6 + S.brow * 0;
      const outer = S.sad * 1.5;
      set("browL", { d: `M110 ${by + outer} Q122 ${by - 4 - S.brow * 2} 134 ${by + inner}` });
      set("browR", { d: `M146 ${by + inner} Q158 ${by - 4 - S.brow * 2} 170 ${by + outer}` });

      // mouth
      const open = clamp(Math.max(S.mouth, S.happy * 0.3), 0, 1);
      const sm = S.smile;
      const cy = 230 - sm * 3.5;
      const w = 13 + sm * 3 + open * 4;
      const up = cy + sm * 5 - open * 2;
      const low = up + open * 24 + 3;
      set("mouth", { d: `M${140 - w} ${cy} Q140 ${up} ${140 + w} ${cy} Q140 ${low} ${140 - w} ${cy} Z` });
      set("tongue", { opacity: clamp(open * 1.6 - 0.4, 0, 0.8), cy: cy + open * 11 + 3 });
      set("blushL", { opacity: S.blush * 0.75 });
      set("blushR", { opacity: S.blush * 0.75 });
      set("sweat", { opacity: clamp(S.sad - 0.4, 0, 1) * 1.6, transform: `translate(0 ${(S.t * 14) % 10})` });

      // monitor
      for (const s of SCREENS) set("scr-" + s, { opacity: S.screen[s] });
      set("scan", { y: 212 + ((S.t * 70) % 66), opacity: S.screen.search });
      set("cell", { opacity: 0.45 + 0.55 * Math.abs(Math.sin(S.t * 5)) });

      // particles
      for (let i = 0; i < parts.length; i++) {
        const q = parts[i];
        const el = e["p" + i];
        if (!el) continue;
        if (q.life <= 0) {
          el.setAttribute("opacity", 0);
          continue;
        }
        q.life -= dt;
        q.vy += 520 * dt;
        q.x += q.vx * dt;
        q.y += q.vy * dt;
        q.r += q.vr * dt;
        el.setAttribute("transform", `translate(${q.x} ${q.y}) rotate(${q.r})`);
        el.setAttribute("fill", q.c);
        el.setAttribute("width", q.w);
        el.setAttribute("height", q.w * 0.55);
        el.setAttribute("opacity", clamp(q.life, 0, 1));
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [levels, info, onMood]);

  return (
    <svg className="char" viewBox="0 0 360 460" role="img" aria-label="Maya, the receptionist">
      <defs>
        <linearGradient id="sun" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFF6DD" stopOpacity=".55" />
          <stop offset="1" stopColor="#FFF6DD" stopOpacity="0" />
        </linearGradient>
        <clipPath id="screenClip"><rect x="238" y="206" width="104" height="80" rx="4" /></clipPath>
      </defs>

      {/* room */}
      <rect width="360" height="460" fill="#E8E1D2" />
      <rect y="372" width="360" height="88" fill="#DDD4C1" />
      <g>
        <rect x="224" y="26" width="104" height="124" rx="9" fill="#F8F4EA" stroke="#D3C9B4" strokeWidth="3" />
        <path d="M276 26v124M224 88h104" stroke="#D3C9B4" strokeWidth="3" />
        <polygon points="224,150 328,150 330,392 212,392" fill="url(#sun)" />
      </g>
      <g>{/* plant */}
        <path d="M30 392l-5-50h38l-5 50z" fill="#C77B58" />
        <path d="M44 344c-18-22-24-44-8-62 4 20 12 38 8 62zM44 344c6-26 20-42 38-46-4 22-16 38-38 46zM44 344c-4-30 0-52 14-70 6 24 0 48-14 70z" fill="#3E7F5F" />
      </g>

      {/* maya */}
      <g ref={ref("body")}>
        <ellipse cx="140" cy="192" rx="54" ry="62" fill={HAIR} />
        <circle cx="140" cy="128" r="22" fill={HAIR} />
        <path d="M52 470C52 344 84 280 140 280s88 64 88 190z" fill={GREEN} />
        <path d="M116 281l24 42 24-42" fill={CREAM} />
        <path d="M116 281l-18 22 24 42M164 281l18 22-24 42" fill="none" stroke={GREEN_D} strokeWidth="3" strokeLinejoin="round" />
        <rect x="176" y="338" width="26" height="16" rx="3" fill={CREAM} />
        <rect x="180" y="343" width="14" height="2.5" rx="1" fill={GREEN} />
        <rect x="124" y="242" width="32" height="48" rx="13" fill={SKIN_D} />
        <g ref={ref("head")}>
          <circle cx="93" cy="206" r="8.5" fill={SKIN} />
          <circle cx="187" cy="206" r="8.5" fill={SKIN} />
          <circle cx="187" cy="216" r="2.6" fill="#E8B04B" />
          <ellipse cx="140" cy="200" rx="46" ry="53" fill={SKIN} />
          <path d="M92 188C88 140 114 120 142 120c30 0 52 20 48 70-8-26-24-38-44-40-6 12-30 24-54 38z" fill={HAIR} />
          <g ref={ref("face")}>
            <ellipse ref={ref("blushL")} cx="114" cy="216" rx="9" ry="6" fill="#E58A7B" opacity="0" />
            <ellipse ref={ref("blushR")} cx="166" cy="216" rx="9" ry="6" fill="#E58A7B" opacity="0" />
            <g ref={ref("eyes")}>
              <ellipse cx="122" cy="199" rx="5" ry="6" fill={INK} />
              <ellipse cx="158" cy="199" rx="5" ry="6" fill={INK} />
              <g ref={ref("pupils")}>
                <circle cx="123.6" cy="197" r="1.8" fill="#fff" />
                <circle cx="159.6" cy="197" r="1.8" fill="#fff" />
              </g>
            </g>
            <g ref={ref("eyesHappy")} opacity="0" fill="none" stroke={INK} strokeWidth="3.2" strokeLinecap="round">
              <path d="M115 202q7-11 14 0" />
              <path d="M151 202q7-11 14 0" />
            </g>
            <path ref={ref("browL")} fill="none" stroke={HAIR} strokeWidth="3.4" strokeLinecap="round" />
            <path ref={ref("browR")} fill="none" stroke={HAIR} strokeWidth="3.4" strokeLinecap="round" />
            <path d="M138 208q3 8 7 3" fill="none" stroke={SKIN_D} strokeWidth="2.4" strokeLinecap="round" />
            <path ref={ref("mouth")} fill={LIP} stroke={LIP} strokeWidth="2" strokeLinejoin="round" />
            <ellipse ref={ref("tongue")} cx="140" cy="236" rx="6" ry="3.2" fill="#C4655E" opacity="0" />
          </g>
          <g ref={ref("sweat")} opacity="0">
            <path d="M182 168q-5 9 0 12 5-3 0-12z" fill="#8EC5E8" />
          </g>
          <path d="M96 188C100 160 120 146 146 146c16 0 32 8 38 22-6 4-14 6-22 6-22 0-46 4-66 14z" fill={HAIR} />
        </g>
      </g>

      {/* desk */}
      <rect y="392" width="360" height="68" fill="#C49A72" />
      <rect y="392" width="360" height="5" fill="#D8B48F" />
      <g>{/* keyboard */}
        <rect x="104" y="404" width="112" height="30" rx="5" fill="#E7E2D6" stroke="#CFC8B8" />
        {[0, 1, 2].map((r) => (
          <path key={r} d={`M${112 + r * 2} ${412 + r * 7}h${96 - r * 4}`} stroke="#C9C2B2" strokeWidth="3" strokeDasharray="6 3" />
        ))}
      </g>

      {/* monitor */}
      <rect x="284" y="294" width="12" height="98" fill="#2A3631" />
      <ellipse cx="290" cy="392" rx="32" ry="5" fill="#2A3631" />
      <rect x="232" y="198" width="116" height="94" rx="9" fill="#1B2420" />
      <rect x="238" y="206" width="104" height="80" rx="4" fill="#F4F1EA" />
      <g clipPath="url(#screenClip)">
        <g ref={ref("scr-idle")}>
          <circle cx="290" cy="238" r="13" fill={GREEN} />
          <circle cx="290" cy="238" r="6" fill="none" stroke="#F4F1EA" strokeWidth="2.4" />
          <rect x="262" y="262" width="56" height="4" rx="2" fill="#CFC8B8" />
          <rect x="272" y="271" width="36" height="4" rx="2" fill="#E0DACB" />
        </g>
        {["search", "found", "notfound"].map((n) => (
          <g key={n} ref={ref("scr-" + n)} opacity="0">
            {[0, 1, 2, 3].map((r) => (
              <g key={r} opacity={n === "notfound" ? 0.35 : 1}>
                <circle cx="250" cy={218 + r * 16} r="5" fill="#BFD9CE" />
                <rect x="260" y={214 + r * 16} width="32" height="7" rx="3.5" fill="#D9D3C4" />
                {[0, 1, 2].map((c) => (
                  <rect key={c} x={298 + c * 14} y={213 + r * 16} width="11" height="9" rx="3" fill={n === "found" && r === 1 && c === 0 ? GREEN : "#E6E1D4"} />
                ))}
              </g>
            ))}
            {n === "search" && <rect ref={ref("scan")} x="238" y="212" width="104" height="14" fill={GREEN} opacity=".18" />}
            {n === "found" && (
              <g>
                <circle cx="290" cy="246" r="20" fill={GREEN} />
                <path d="M280 246l8 8 14-16" fill="none" stroke="#F4F1EA" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
              </g>
            )}
            {n === "notfound" && <text x="290" y="262" textAnchor="middle" fontFamily="Fraunces, serif" fontSize="44" fill="#8A948F">?</text>}
          </g>
        ))}
        {["book", "booked", "cancel", "cancelled", "failed"].map((n) => (
          <g key={n} ref={ref("scr-" + n)} opacity="0">
            <rect x="238" y="206" width="104" height="14" fill={n === "cancel" || n === "cancelled" ? "#C2492F" : GREEN} />
            {[0, 1, 2, 3].map((r) =>
              [0, 1, 2, 3, 4, 5].map((c) => (
                <rect key={r + "-" + c} x={246 + c * 15} y={228 + r * 14} width="10" height="9" rx="2.5"
                  fill={r === 1 && c === 3 ? (n === "booked" ? GREEN : n === "cancelled" ? "#C2492F" : "#BFD9CE") : "#E6E1D4"}
                  ref={r === 1 && c === 3 && (n === "book" || n === "cancel") ? ref("cell") : undefined} />
              ))
            )}
            {n === "booked" && <path d="M268 262l8 8 18-20" fill="none" stroke={GREEN} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />}
            {n === "cancelled" && <path d="M268 250l24 22M292 250l-24 22" stroke="#C2492F" strokeWidth="5" strokeLinecap="round" />}
            {n === "failed" && <text x="290" y="276" textAnchor="middle" fontFamily="Fraunces, serif" fontSize="38" fill="#8A948F">!</text>}
          </g>
        ))}
      </g>

      {/* desk phone */}
      <g>
        <path d="M14 392l10-22h76l10 22z" fill="#20302B" />
        <rect x="40" y="364" width="6" height="8" fill="#20302B" />
        <rect x="76" y="364" width="6" height="8" fill="#20302B" />
        <g ref={ref("rings")} opacity="0" fill="none" stroke={GREEN} strokeWidth="3" strokeLinecap="round">
          <path d="M44 330q-7 7 0 14M34 322q-13 14 0 28" />
          <path d="M80 330q7 7 0 14M90 322q13 14 0 28" />
        </g>
      </g>

      {/* arms (sleeves), then hands and handset on top */}
      <path ref={ref("armR")} fill="none" stroke={GREEN} strokeWidth="26" strokeLinecap="round" strokeLinejoin="round" />
      <path ref={ref("armL")} fill="none" stroke={GREEN} strokeWidth="26" strokeLinecap="round" strokeLinejoin="round" />
      <g ref={ref("handset")}>
        <rect x="-7" y="-35" width="14" height="70" rx="7" fill="#20302B" />
        <rect x="-11" y="-38" width="22" height="16" rx="7" fill="#2E423B" />
        <rect x="-11" y="22" width="22" height="16" rx="7" fill="#2E423B" />
      </g>
      <g ref={ref("handR")}><rect x="-12" y="-15" width="24" height="30" rx="11" fill={SKIN} /></g>
      <g ref={ref("handL")}><rect x="-12" y="-14" width="24" height="28" rx="11" fill={SKIN} /></g>

      {/* confetti */}
      <g>{Array.from({ length: 36 }, (_, i) => <rect key={i} ref={ref("p" + i)} x="-3" y="-2" width="6" height="3" opacity="0" />)}</g>
    </svg>
  );
}
