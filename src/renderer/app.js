// Shared context object — modules register functions here to avoid circular deps.
// Other modules call app.functionName() which resolves at call time.
const app = {
  ipcRenderer: null,
  // DOM refs, state, terminals, etc. are attached by other modules
};

/**
 * Play a close animation on an element, then add "hidden" class.
 * @param {HTMLElement} el - element to animate out
 * @param {string} animName - CSS @keyframes name
 * @param {number} duration - ms
 */
app.animateClose = function (el, animName, duration = 150) {
  if (el.classList.contains("hidden")) return;
  el.style.animation = `${animName} ${duration}ms var(--ease-smooth) forwards`;
  setTimeout(() => {
    el.classList.add("hidden");
    el.style.animation = "";
  }, duration);
};

module.exports = app;
