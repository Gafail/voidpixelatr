/* ==========================================================================
   VoidPixelatr — menu.js
   --------------------------------------------------------------------------
   The menu: one column on the left, and everything in it drops open.

   There used to be two columns of controls — the palette on the far left
   and the Image mode's controls beside it — and they were both open at the
   same time, so the screen was a wall of sliders before you had drawn
   anything. Now there is one menu. Each section is a header that opens a
   body, and only the header is on screen until the section is wanted.

   The colours are a pop-over rather than a section. A sixty-four swatch
   grid is taller than the whole menu, and it is wanted for a moment at a
   time rather than all the time — so it floats over the canvas, next to
   the button that opened it, and closes when it is no longer needed.
   ========================================================================== */

(function (root) {
  "use strict";

  const VP = root.VP || (root.VP = {});
  const M = (VP.menu = {});

  /* How far the pop-over sits from the button that opened it. */
  const GAP = 8;

  const state = {
    coloursOpen: false,
  };

  M.state = state;

  /* --- the sections --------------------------------------------------------- */

  /* Every header with a body behind it opens and closes that body. The
     sections are independent: two of them can be open at once, because a
     conversion usually wants the adjustments and the target size together.

     The colours section has no body — it opens a pop-over instead — so it
     is left alone here. */
  function bindSections() {
    const heads = root.document.querySelectorAll(".menu-section > .menu-head");
    for (const head of heads) {
      const body = head.nextElementSibling;
      if (!body || !body.classList.contains("menu-body")) continue;

      head.addEventListener("click", () => {
        const open = head.getAttribute("aria-expanded") === "true";
        setOpen(head, body, !open);
      });
    }
  }

  function setOpen(head, body, open) {
    head.setAttribute("aria-expanded", open ? "true" : "false");
    body.hidden = !open;
  }

  /* Opens or shuts a named section from code. The name is the section's
     `data-section`. */
  M.setSection = function setSection(name, open) {
    const section = root.document.querySelector('.menu-section[data-section="' + name + '"]');
    if (!section) return false;
    const head = section.querySelector(".menu-head");
    const body = section.querySelector(".menu-body");
    if (!head || !body) return false;
    setOpen(head, body, open);
    return true;
  };

  M.sectionOpen = function sectionOpen(name) {
    const section = root.document.querySelector('.menu-section[data-section="' + name + '"]');
    if (!section) return false;
    const head = section.querySelector(".menu-head");
    return !!head && head.getAttribute("aria-expanded") === "true";
  };

  /* --- the colour pop-over -------------------------------------------------- */

  function panel() {
    return root.document.getElementById("colour-popover");
  }

  function trigger() {
    return root.document.getElementById("colours-toggle");
  }

  /* The pop-over opens to the right of the menu, at the height of the
     button that opened it. If it would run off the right of the window it
     opens to the left instead; if it would run off the bottom it moves up.
     It is measured after it is shown, because a hidden element has no
     size. */
  function place() {
    const box = panel();
    const button = trigger();
    if (!box || !button || box.hidden) return;

    const anchor = button.getBoundingClientRect();
    const size = box.getBoundingClientRect();
    const viewWidth = root.innerWidth || 0;
    const viewHeight = root.innerHeight || 0;

    let left = anchor.right + GAP;
    if (left + size.width > viewWidth - GAP) {
      left = anchor.left - size.width - GAP;
    }
    if (left < GAP) left = GAP;

    let top = anchor.top;
    if (top + size.height > viewHeight - GAP) {
      top = viewHeight - size.height - GAP;
    }
    if (top < GAP) top = GAP;

    box.style.left = Math.round(left) + "px";
    box.style.top = Math.round(top) + "px";
  }

  M.reposition = place;

  function setColours(open) {
    const box = panel();
    const button = trigger();
    if (!box || !button) return;

    state.coloursOpen = open;
    box.hidden = !open;
    button.setAttribute("aria-expanded", open ? "true" : "false");

    if (open) place();
  }

  M.openColours = function openColours() {
    setColours(true);
  };

  M.closeColours = function closeColours() {
    setColours(false);
  };

  M.toggleColours = function toggleColours() {
    setColours(!state.coloursOpen);
  };

  M.coloursOpen = function coloursOpen() {
    return state.coloursOpen;
  };

  function bindPopover() {
    const button = trigger();
    if (!button) return;

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      M.toggleColours();
    });

    /* A click anywhere else puts it away. The swatches inside the panel are
       not "anywhere else", so the panel is asked whether it contains the
       click before it closes. */
    root.document.addEventListener("click", (event) => {
      if (!state.coloursOpen) return;
      const box = panel();
      if (box && box.contains(event.target)) return;
      if (button.contains(event.target)) return;
      M.closeColours();
    });

    root.document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (!state.coloursOpen) return;
      M.closeColours();
      button.focus();
    });

    /* The window can change under the pop-over — a resize, or a scroll of
       the menu behind it. It follows the button. */
    root.addEventListener("resize", place);
    root.addEventListener("scroll", place, true);

    /* The palette changes the height of the grid inside it, so the panel is
       re-placed whenever its own size changes. */
    if (root.ResizeObserver) {
      const observer = new root.ResizeObserver(() => place());
      const box = panel();
      if (box) observer.observe(box);
    }
  }

  /* --- wiring --------------------------------------------------------------- */

  M.init = function init() {
    bindSections();
    bindPopover();
  };
})(
  typeof window !== "undefined"
    ? window
    : (typeof globalThis !== "undefined" ? globalThis : this)
);
