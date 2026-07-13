// ---- Configure this before shipping ----
const GITHUB_REPO_URL = "https://github.com/replicolabs/moot";
const SLACK_INVITE_URL = "https://app.heymoot.xyz/slack/install"; // real public "Add to Slack" OAuth install flow
// -----------------------------------------

document.getElementById("slack-link").href = SLACK_INVITE_URL;

// Live star count -- silently no-ops if the fetch fails or is rate-limited.
(async () => {
  try {
    const match = GITHUB_REPO_URL.match(/github\.com\/([^/]+)\/([^/]+)\/?$/);
    if (!match) return;
    const res = await fetch(`https://api.github.com/repos/${match[1]}/${match[2]}`);
    if (!res.ok) return;
    const data = await res.json();
    if (typeof data.stargazers_count === "number") {
      const el = document.getElementById("star-count");
      el.textContent = data.stargazers_count.toLocaleString();
      el.style.display = "inline-block";
    }
  } catch {
    /* offline, repo not public yet, or rate-limited -- button still works without a count */
  }
})();

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const isCoarsePointer = window.matchMedia("(pointer: coarse)").matches;
const canAnimate = !prefersReducedMotion && !isCoarsePointer;

if (canAnimate) {
  initSpotlight();
  initCursor();
  initTilt();
  initParticles();
}

function initSpotlight() {
  window.addEventListener(
    "pointermove",
    (e) => {
      document.documentElement.style.setProperty("--mx", `${e.clientX}px`);
      document.documentElement.style.setProperty("--my", `${e.clientY}px`);
    },
    { passive: true }
  );
}

function initCursor() {
  const dot = document.querySelector(".cursor-dot");
  const ring = document.querySelector(".cursor-ring");
  let mouseX = window.innerWidth / 2;
  let mouseY = window.innerHeight / 2;
  let ringX = mouseX;
  let ringY = mouseY;

  window.addEventListener(
    "pointermove",
    (e) => {
      mouseX = e.clientX;
      mouseY = e.clientY;
      dot.style.transform = `translate(${mouseX}px, ${mouseY}px) translate(-50%, -50%)`;
      dot.style.opacity = "1";
      ring.style.opacity = "1";
    },
    { passive: true }
  );

  window.addEventListener("pointerleave", () => {
    dot.style.opacity = "0";
    ring.style.opacity = "0";
  });

  for (const el of document.querySelectorAll("a, button")) {
    el.addEventListener("mouseenter", () => ring.classList.add("is-hovering"));
    el.addEventListener("mouseleave", () => ring.classList.remove("is-hovering"));
  }

  function tick() {
    ringX += (mouseX - ringX) * 0.18;
    ringY += (mouseY - ringY) * 0.18;
    ring.style.transform = `translate(${ringX}px, ${ringY}px) translate(-50%, -50%)`;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function initTilt() {
  const frame = document.getElementById("shot-frame");
  if (!frame) return;
  const maxDeg = 6;

  window.addEventListener(
    "pointermove",
    (e) => {
      const rect = frame.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = (e.clientX - cx) / (window.innerWidth / 2);
      const dy = (e.clientY - cy) / (window.innerHeight / 2);
      const rotateY = Math.max(-1, Math.min(1, dx)) * maxDeg;
      const rotateX = Math.max(-1, Math.min(1, -dy)) * maxDeg;
      frame.style.transform = `rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
    },
    { passive: true }
  );
}

function initParticles() {
  const canvas = document.getElementById("particles");
  const ctx = canvas.getContext("2d");
  let width, height, dpr;
  let particles = [];

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function makeParticles() {
    const count = Math.round((width * height) / 22000);
    particles = Array.from({ length: count }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      r: Math.random() * 1.1 + 0.3,
      vx: (Math.random() - 0.5) * 0.06,
      vy: (Math.random() - 0.5) * 0.06,
      phase: Math.random() * Math.PI * 2,
    }));
  }

  resize();
  makeParticles();
  window.addEventListener("resize", () => {
    resize();
    makeParticles();
  });

  let t = 0;
  function draw() {
    t += 0.01;
    ctx.clearRect(0, 0, width, height);
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0) p.x = width;
      if (p.x > width) p.x = 0;
      if (p.y < 0) p.y = height;
      if (p.y > height) p.y = 0;

      const twinkle = 0.35 + 0.35 * Math.sin(t * 2 + p.phase);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${twinkle})`;
      ctx.fill();
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
}
