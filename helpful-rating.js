/**
 * KokonutUI HelpfulRating (Vanilla JS + Smooth CSS/SVG Spring Implementation)
 * Adapted for Momentum Chasers (Dark & Light Theme compatible, posts to /api/feedback).
 */
(function () {
  'use strict';

  const LEVELS = [
    { label: 'Awful', color: '#f43f5e', mouth: -13, brow: 6, eye: 6 },
    { label: 'Meh', color: '#f97316', mouth: -6, brow: 3, eye: 6 },
    { label: 'Okay', color: '#a1a1aa', mouth: 0, brow: 0, eye: 6 },
    { label: 'Good', color: '#0ea5e9', mouth: 9, brow: 0, eye: 5.5 },
    { label: 'Love it', color: '#10b981', mouth: 17, brow: 0, eye: 3 }
  ];

  const LOW_REASONS = ['Hard to follow', 'Missing an example', 'Out of date', "Code didn't work"];
  const HIGH_REASONS = ['Clear steps', 'Good examples', 'Found it fast'];
  const MIDDLE = 2;

  function injectStyles() {
    if (document.getElementById('kokonut-helpful-rating-styles')) return;
    const style = document.createElement('style');
    style.id = 'kokonut-helpful-rating-styles';
    style.textContent = `
      .hr-card {
        width: 100%;
        max-width: 390px;
        margin: 0 auto;
        overflow: hidden;
        border-radius: 24px;
        border: 1px solid rgba(148, 163, 184, 0.22);
        background: #09090b;
        color: #f4f4f5;
        padding: 22px 20px;
        box-sizing: border-box;
        font-family: var(--font-sans, 'Inter', system-ui, -apple-system, sans-serif);
      }
      body.theme-white .hr-card, .hr-card.hr-light {
        background: #ffffff;
        color: #18181b;
        border-color: #e4e4e7;
      }
      .hr-head { display: flex; flex-direction: column; align-items: center; text-align: center; }
      .hr-face-wrap { width: 80px; height: 80px; transition: transform 0.42s cubic-bezier(0.22, 1, 0.36, 1); }
      .hr-face-wrap.is-sent { animation: hr-bounce 0.45s cubic-bezier(0.23, 1, 0.32, 1); }
      @keyframes hr-bounce { 0% { transform: translateY(0); } 40% { transform: translateY(-8px); } 100% { transform: translateY(0); } }
      .hr-face-svg { width: 80px; height: 80px; transition: transform 0.32s cubic-bezier(0.23, 1, 0.32, 1); overflow: visible; }
      .hr-face-features { transition: transform 0.32s cubic-bezier(0.23, 1, 0.32, 1); }
      .hr-face-circle { transition: fill 200ms ease-out; }
      .hr-face-eye { transition: ry 0.25s cubic-bezier(0.23, 1, 0.32, 1); }
      .hr-face-brow { transition: opacity 0.22s ease; }
      .hr-title { margin: 12px 0 0; font-size: 16px; font-weight: 600; letter-spacing: -0.015em; line-height: 1.3; }
      .hr-sub { margin: 3px 0 0; font-size: 13px; color: #a1a1aa; min-height: 20px; }
      body.theme-white .hr-sub, .hr-card.hr-light .hr-sub { color: #71717a; }

      .hr-radiogroup {
        position: relative;
        margin-top: 16px;
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 6px;
      }
      .hr-slider-pill {
        position: absolute;
        top: 0;
        left: 0;
        height: 40px;
        border-radius: 12px;
        pointer-events: none;
        opacity: 0;
        transition: transform 0.34s cubic-bezier(0.22, 1, 0.36, 1), background-color 200ms ease-out, opacity 0.16s ease;
        z-index: 0;
      }
      .hr-face-btn {
        position: relative;
        z-index: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        height: 40px;
        border-radius: 12px;
        border: none;
        background: #18181b;
        color: #a1a1aa;
        cursor: pointer;
        outline: none;
        transition: background-color 150ms ease, color 150ms ease;
      }
      body.theme-white .hr-face-btn, .hr-card.hr-light .hr-face-btn {
        background: #f4f4f5;
        color: #71717a;
      }
      .hr-face-btn:hover { background: #27272a; color: #f4f4f5; }
      body.theme-white .hr-face-btn:hover, .hr-card.hr-light .hr-face-btn:hover { background: #e4e4e7; color: #27272a; }
      .hr-face-btn.is-selected { background: transparent !important; color: #ffffff !important; }
      .hr-face-btn:focus-visible { box-shadow: 0 0 0 2px rgba(161, 161, 170, 0.5); }

      .hr-details {
        overflow: hidden;
        max-height: 0;
        opacity: 0;
        transition: max-height 0.32s cubic-bezier(0.23, 1, 0.32, 1), opacity 0.22s ease;
      }
      .hr-details.is-open { max-height: 360px; opacity: 1; }
      .hr-prompt { margin: 16px 0 0; font-size: 13px; color: #a1a1aa; text-align: left; }
      body.theme-white .hr-prompt, .hr-card.hr-light .hr-prompt { color: #71717a; }
      .hr-chips {
        margin-top: 8px;
        display: flex;
        flex-wrap: wrap;
        align-content: flex-start;
        gap: 6px;
        min-height: 70px;
      }
      .hr-chip {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        height: 32px;
        padding: 0 12px;
        border-radius: 999px;
        border: 1px solid #27272a;
        background: transparent;
        color: inherit;
        font-size: 12.5px;
        cursor: pointer;
        transition: background-color 150ms ease, color 150ms ease, border-color 150ms ease;
      }
      body.theme-white .hr-chip, .hr-card.hr-light .hr-chip { border-color: #e4e4e7; }
      .hr-chip:hover { border-color: #52525b; }
      body.theme-white .hr-chip:hover, .hr-card.hr-light .hr-chip:hover { border-color: #a1a1aa; }
      .hr-chip.is-on {
        background: #ffffff;
        color: #18181b;
        border-color: #ffffff;
        font-weight: 500;
      }
      body.theme-white .hr-chip.is-on, .hr-card.hr-light .hr-chip.is-on {
        background: #18181b;
        color: #ffffff;
        border-color: #18181b;
      }
      .hr-note {
        margin-top: 8px;
        display: block;
        width: 100%;
        height: 78px;
        resize: none;
        border-radius: 12px;
        border: 1px solid transparent;
        background: #18181b;
        color: inherit;
        padding: 9px 12px;
        font-size: 13.5px;
        font-family: inherit;
        box-sizing: border-box;
        outline: none;
      }
      body.theme-white .hr-note, .hr-card.hr-light .hr-note { background: #f4f4f5; }
      .hr-note:focus { border-color: rgba(161, 161, 170, 0.5); }
      .hr-note::placeholder { color: #71717a; }
      .hr-submit {
        margin-top: 12px;
        height: 40px;
        width: 100%;
        border-radius: 12px;
        border: none;
        background: #ffffff;
        color: #18181b;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: background-color 150ms ease, opacity 150ms ease;
      }
      body.theme-white .hr-submit, .hr-card.hr-light .hr-submit { background: #18181b; color: #ffffff; }
      .hr-submit:hover { opacity: 0.9; }
      .hr-submit:disabled { opacity: 0.6; cursor: not-allowed; }
      .hr-reset {
        margin: 12px auto 0;
        display: block;
        background: none;
        border: none;
        color: #a1a1aa;
        font-size: 12.5px;
        cursor: pointer;
        text-underline-offset: 4px;
      }
      .hr-reset:hover { color: #ffffff; text-decoration: underline; }
      body.theme-white .hr-reset:hover, .hr-card.hr-light .hr-reset:hover { color: #18181b; }
    `;
    document.head.appendChild(style);
  }

  function mouthPath(bend) {
    return `M33 64 Q50 ${64 + bend} 67 64`;
  }
  function browPath(side, tilt) {
    const outer = side === -1 ? 26 : 74;
    const inner = side === -1 ? 42 : 58;
    return `M${outer} ${30 + tilt * 0.4} L${inner} ${30 - tilt}`;
  }

  function mountHelpfulRating(container, options = {}) {
    if (!container) return null;
    injectStyles();

    const question = options.question || 'Was this page helpful?';
    let rating = null;
    let preview = null;
    let reasons = [];
    let note = '';
    let sent = false;
    let submitting = false;

    container.innerHTML = `
      <div class="hr-card">
        <div class="hr-head">
          <div class="hr-face-wrap">
            <svg class="hr-face-svg" aria-hidden="true" viewBox="0 0 100 100">
              <circle class="hr-face-circle" cx="50" cy="50" r="47" fill="${LEVELS[MIDDLE].color}"></circle>
              <g class="hr-face-features">
                <path class="hr-face-brow hr-brow-l" fill="none" stroke="white" stroke-linecap="round" stroke-width="4"></path>
                <path class="hr-face-brow hr-brow-r" fill="none" stroke="white" stroke-linecap="round" stroke-width="4"></path>
                <ellipse class="hr-face-eye hr-eye-l" cx="36" cy="44" rx="5" ry="6" fill="white"></ellipse>
                <ellipse class="hr-face-eye hr-eye-r" cx="64" cy="44" rx="5" ry="6" fill="white"></ellipse>
                <path class="hr-face-mouth" fill="none" stroke="white" stroke-linecap="round" stroke-width="5"></path>
              </g>
            </svg>
          </div>
          <p class="hr-title">${question}</p>
          <p class="hr-sub">${LEVELS[MIDDLE].label}</p>
        </div>

        <div class="hr-body">
          <div class="hr-radiogroup" role="radiogroup" aria-label="${question}">
            <span class="hr-slider-pill" aria-hidden="true"></span>
            ${LEVELS.map((l, i) => `
              <button type="button" class="hr-face-btn" role="radio" aria-checked="false" aria-label="${l.label}" data-idx="${i}" tabindex="${i === MIDDLE ? 0 : -1}">
                <svg aria-hidden="true" width="24" height="24" fill="none" viewBox="0 0 24 24">
                  <circle cx="8.5" cy="9" fill="currentColor" r="1.8"></circle>
                  <circle cx="15.5" cy="9" fill="currentColor" r="1.8"></circle>
                  <path d="M7 15 Q12 ${15 + l.mouth * 0.35} 17 15" stroke="currentColor" stroke-linecap="round" stroke-width="2.4"></path>
                </svg>
              </button>
            `).join('')}
          </div>

          <div class="hr-details">
            <p class="hr-prompt">What helped most?</p>
            <div class="hr-chips"></div>
            <textarea class="hr-note" aria-label="Anything else?" placeholder="Anything else? (optional)"></textarea>
            <button type="button" class="hr-submit">Send feedback</button>
          </div>
        </div>

        <button type="button" class="hr-reset" style="display:none;">Change my answer</button>
      </div>
    `;

    const card = container.querySelector('.hr-card');
    const faceWrap = card.querySelector('.hr-face-wrap');
    const faceSvg = card.querySelector('.hr-face-svg');
    const faceCircle = card.querySelector('.hr-face-circle');
    const faceFeatures = card.querySelector('.hr-face-features');
    const browL = card.querySelector('.hr-brow-l');
    const browR = card.querySelector('.hr-brow-r');
    const eyeL = card.querySelector('.hr-eye-l');
    const eyeR = card.querySelector('.hr-eye-r');
    const mouthEl = card.querySelector('.hr-face-mouth');
    const titleEl = card.querySelector('.hr-title');
    const subEl = card.querySelector('.hr-sub');
    const bodyEl = card.querySelector('.hr-body');
    const radiogroup = card.querySelector('.hr-radiogroup');
    const sliderPill = card.querySelector('.hr-slider-pill');
    const faceBtns = Array.from(card.querySelectorAll('.hr-face-btn'));
    const detailsEl = card.querySelector('.hr-details');
    const promptEl = card.querySelector('.hr-prompt');
    const chipsEl = card.querySelector('.hr-chips');
    const noteEl = card.querySelector('.hr-note');
    const submitBtn = card.querySelector('.hr-submit');
    const resetBtn = card.querySelector('.hr-reset');

    // Track animated mouth/brow values smoothly via rAF
    let curMouth = LEVELS[MIDDLE].mouth;
    let curBrow = LEVELS[MIDDLE].brow;
    let targetMouth = curMouth;
    let targetBrow = curBrow;
    let animId = 0;

    function tickFace() {
      curMouth += (targetMouth - curMouth) * 0.25;
      curBrow += (targetBrow - curBrow) * 0.25;
      mouthEl.setAttribute('d', mouthPath(curMouth));
      browL.setAttribute('d', browPath(-1, curBrow));
      browR.setAttribute('d', browPath(1, curBrow));
      if (Math.abs(targetMouth - curMouth) > 0.08 || Math.abs(targetBrow - curBrow) > 0.08) {
        animId = requestAnimationFrame(tickFace);
      } else {
        mouthEl.setAttribute('d', mouthPath(targetMouth));
        browL.setAttribute('d', browPath(-1, targetBrow));
        browR.setAttribute('d', browPath(1, targetBrow));
        animId = 0;
      }
    }

    function renderChips() {
      if (rating === null) return;
      const low = rating < MIDDLE;
      promptEl.textContent = low ? 'What went wrong?' : 'What helped most?';
      const choices = low ? LOW_REASONS : HIGH_REASONS;
      chipsEl.innerHTML = choices.map(r => {
        const on = reasons.includes(r);
        return `
          <button type="button" class="hr-chip ${on ? 'is-on' : ''}" aria-pressed="${on}" data-reason="${r.replace(/"/g, '&quot;')}">
            ${on ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>' : ''}
            <span>${r}</span>
          </button>
        `;
      }).join('');
      chipsEl.querySelectorAll('.hr-chip').forEach(btn => {
        btn.addEventListener('click', () => {
          const r = btn.getAttribute('data-reason');
          reasons = reasons.includes(r) ? reasons.filter(x => x !== r) : [...reasons, r];
          renderChips();
        });
      });
    }

    function updateUI() {
      const shown = preview !== null ? preview : (rating !== null ? rating : MIDDLE);
      const level = sent ? { ...LEVELS[4], color: LEVELS[shown].color } : LEVELS[shown];
      const look = shown - MIDDLE;

      faceCircle.style.fill = level.color;
      faceSvg.style.transform = `rotate(${look * 3}deg)`;
      faceFeatures.style.transform = `translateX(${look * 2.5}px)`;
      eyeL.setAttribute('ry', level.eye);
      eyeR.setAttribute('ry', level.eye);
      browL.style.opacity = level.brow ? '1' : '0';
      browR.style.opacity = level.brow ? '1' : '0';

      targetMouth = level.mouth;
      targetBrow = level.brow;
      if (!animId) animId = requestAnimationFrame(tickFace);

      faceWrap.classList.toggle('is-sent', sent);
      titleEl.textContent = sent ? 'Thanks, that helps' : question;
      subEl.textContent = sent ? 'We read every note.' : level.label;
      bodyEl.style.display = sent ? 'none' : 'block';
      resetBtn.style.display = sent ? 'block' : 'none';

      faceBtns.forEach((btn, i) => {
        const sel = rating === i;
        btn.classList.toggle('is-selected', sel);
        btn.setAttribute('aria-checked', String(sel));
        btn.setAttribute('tabindex', i === (rating !== null ? rating : MIDDLE) ? '0' : '-1');
      });

      if (rating !== null) {
        const activeBtn = faceBtns[rating];
        sliderPill.style.opacity = '1';
        sliderPill.style.width = activeBtn.offsetWidth + 'px';
        sliderPill.style.transform = `translateX(${activeBtn.offsetLeft}px)`;
        sliderPill.style.backgroundColor = LEVELS[rating].color;
        detailsEl.classList.add('is-open');
      } else {
        sliderPill.style.opacity = '0';
        detailsEl.classList.remove('is-open');
      }
    }

    function pick(i) {
      if (rating !== null && (i < MIDDLE) !== (rating < MIDDLE)) {
        reasons = [];
      }
      rating = i;
      renderChips();
      updateUI();
    }

    radiogroup.addEventListener('pointerleave', () => { preview = null; updateUI(); });
    faceBtns.forEach((btn, i) => {
      btn.addEventListener('pointerenter', e => {
        if (e.pointerType === 'mouse') { preview = i; updateUI(); }
      });
      btn.addEventListener('focus', () => { preview = i; updateUI(); });
      btn.addEventListener('blur', () => { preview = null; updateUI(); });
      btn.addEventListener('click', () => pick(i));
      btn.addEventListener('keydown', e => {
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (step) {
          e.preventDefault();
          const next = (i + step + LEVELS.length) % LEVELS.length;
          faceBtns[next].focus();
          pick(next);
        }
      });
    });

    noteEl.addEventListener('input', () => { note = noteEl.value; });

    submitBtn.addEventListener('click', async () => {
      if (rating === null || submitting) return;
      submitting = true;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending...';
      const payload = {
        rating: rating + 1,
        sentiment: LEVELS[rating].label,
        reasons: reasons.slice(),
        note: note.trim()
      };
      try {
        if (typeof options.onSubmit === 'function') {
          await options.onSubmit(payload);
        }
      } catch (_) { }
      submitting = false;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send feedback';
      preview = null;
      sent = true;
      updateUI();
    });

    resetBtn.addEventListener('click', () => {
      rating = null;
      preview = null;
      reasons = [];
      note = '';
      noteEl.value = '';
      sent = false;
      updateUI();
    });

    updateUI();
    return { reset: () => resetBtn.click() };
  }

  window.mountHelpfulRating = mountHelpfulRating;
})();
