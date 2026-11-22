(() => {
  if (globalThis.__floatingNotesFullscreenBridge) return;
  globalThis.__floatingNotesFullscreenBridge = true;

  const nativeRequestFullscreen = Element.prototype.requestFullscreen;
  if (typeof nativeRequestFullscreen !== "function") return;

  const records = new WeakMap();

  Element.prototype.requestFullscreen = function floatingNotesRequestFullscreen(options) {
    if (!(this instanceof HTMLVideoElement) || this.closest("[data-floating-notes-video-wrapper]")) {
      return nativeRequestFullscreen.call(this, options);
    }

    const video = this;
    const parent = video.parentNode;
    if (!parent) return nativeRequestFullscreen.call(video, options);

    const wrapper = document.createElement("div");
    wrapper.dataset.floatingNotesVideoWrapper = "true";
    Object.assign(wrapper.style, {
      position: "relative",
      width: "100%",
      height: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
      background: "#000"
    });

    const record = {
      video,
      parent,
      nextSibling: video.nextSibling,
      style: video.getAttribute("style")
    };
    records.set(wrapper, record);
    parent.insertBefore(wrapper, video);
    wrapper.append(video);
    video.style.setProperty("width", "100%", "important");
    video.style.setProperty("height", "100%", "important");
    video.style.setProperty("max-width", "none", "important");
    video.style.setProperty("max-height", "none", "important");
    video.style.setProperty("object-fit", "contain", "important");

    let result;
    try {
      result = nativeRequestFullscreen.call(wrapper, options);
    } catch (error) {
      restoreVideo(wrapper);
      throw error;
    }

    return Promise.resolve(result).catch((error) => {
      restoreVideo(wrapper);
      throw error;
    });
  };

  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement) return;
    document.querySelectorAll("[data-floating-notes-video-wrapper]").forEach(restoreVideo);
  });

  function restoreVideo(wrapper) {
    const record = records.get(wrapper);
    if (!record) return;
    const { video, parent, nextSibling, style } = record;
    if (nextSibling?.parentNode === parent) parent.insertBefore(video, nextSibling);
    else parent.append(video);
    if (style == null) video.removeAttribute("style");
    else video.setAttribute("style", style);
    wrapper.remove();
    records.delete(wrapper);
  }
})();

