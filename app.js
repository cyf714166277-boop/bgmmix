"use strict";
/* Pitch navigation: hero orbit, chapter rail highlight, keyboard paging. */
const soundOrbit = document.querySelector("#soundOrbit");
const heroPlay = document.querySelector("#heroPlay");
heroPlay.addEventListener("click", () => {
  const on = soundOrbit.classList.toggle("is-playing");
  heroPlay.querySelector("span").textContent = on ? "Ⅱ" : "▶";
});

const pitchLinks = Array.from(document.querySelectorAll(".pitch-rail a"));
const observedSections = Array.from(document.querySelectorAll("[data-pitch-section]"));
if ("IntersectionObserver" in window) {
  const sectionObserver = new IntersectionObserver((entries) => {
    const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    pitchLinks.forEach((link) => link.classList.toggle("active", link.getAttribute("href") === `#${visible.target.id}`));
  }, { rootMargin: "-25% 0px -55%", threshold: [0, 0.2, 0.6] });
  observedSections.forEach((section) => sectionObserver.observe(section));
}

document.addEventListener("keydown", (event) => {
  if (!["ArrowDown", "ArrowUp", "PageDown", "PageUp"].includes(event.key)) return;
  if (["INPUT", "TEXTAREA", "BUTTON", "SELECT"].includes(document.activeElement.tagName)) return;
  if (document.activeElement.closest && document.activeElement.closest("#studio")) return;
  const sectionTops = observedSections.map((section) => ({ section, distance: Math.abs(section.getBoundingClientRect().top - 90) }));
  const currentIndex = sectionTops.indexOf(sectionTops.reduce((closest, item) => (item.distance < closest.distance ? item : closest)));
  const direction = event.key === "ArrowDown" || event.key === "PageDown" ? 1 : -1;
  const nextIndex = Math.max(0, Math.min(observedSections.length - 1, currentIndex + direction));
  if (nextIndex !== currentIndex) {
    event.preventDefault();
    observedSections[nextIndex].scrollIntoView({ behavior: "smooth", block: "start" });
  }
});
