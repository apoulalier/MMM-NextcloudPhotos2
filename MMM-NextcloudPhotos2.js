Module.register("MMM-NextcloudPhotos2", {
  defaults: {
    // Nextcloud settings
    nextcloudUrl: "",
    username: "",
    folder: "mirror",

    // Token file (credentials are stored in tokens.json by setup_oauth.js)
    tokenFile: "tokens.json",

    // Display settings
    updateInterval: 30 * 1000,       // Image rotation: 30 seconds
    syncInterval: 10 * 60 * 1000,    // Nextcloud sync: 10 minutes
    transitionDuration: 2000,         // Crossfade duration in ms
    backgroundSize: "cover",          // cover | contain
    order: "random",                  // random | sequential
    opacity: 1.0,                     // Background opacity

    // Image optimization (for low-memory devices like RP3)
    maxWidth: 1920,                  // Max image width in pixels
    maxHeight: 1080,                 // Max image height in pixels
    imageQuality: 80,               // JPEG quality (1-100)
    albums : ["Anniversaire 1 an", "Montreux 2023"],
  },

  photos: [],
  currentIndex: -1,
  activeLayer: 0,
  rotationTimer: null,
  errorMessage: null,
  layers: [],

  start: function () {
    Log.info("[MMM-NextcloudPhotos2] Module loading...");
    this.sendSocketNotification("SET_CONFIG", this.config);
  },

  getStyles: function () {
    return ["css/MMM-NextcloudPhotos.css"];
  },

  getDom: function () {
    var wrapper = document.createElement("div");
    wrapper.className = "mmm-ncp-wrapper";
    // Inline styles as fallback in case CSS doesn't load
    //wrapper.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:0;overflow:hidden;background-color:#000;";

    // Make body background transparent so our wrapper shows through
    document.body.style.background = "transparent";

    if (this.errorMessage) {
      var errorDiv = document.createElement("div");
      errorDiv.className = "mmm-ncp-error";
      //errorDiv.style.cssText = "display:flex;align-items:center;justify-content:center;width:100%;height:100%;color:rgba(255,100,100,0.6);font-size:1rem;";
      errorDiv.textContent = this.errorMessage;
      wrapper.appendChild(errorDiv);
      return wrapper;
    }

    if (this.photos.length === 0) {
      var loadingDiv = document.createElement("div");
      loadingDiv.className = "mmm-ncp-loading";
      //loadingDiv.style.cssText = "display:flex;align-items:center;justify-content:center;width:100%;height:100%;color:rgba(255,255,255,0.3);font-size:1.2rem;";
      loadingDiv.textContent = "Loading...";
      wrapper.appendChild(loadingDiv);
      return wrapper;
    }

    // Two image layers for crossfade - all styles inline
    this.layers = [];
    for (var i = 0; i < 2; i++) {
      var layer = document.createElement("div");
      layer.className = "mmm-ncp-layer mmm-ncp-layer-" + i;
      //layer.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;" +
      //  "background-position:center center;background-repeat:no-repeat;background-size:cover;" +
      //  "opacity:0;transition:opacity " + this.config.transitionDuration + "ms ease-in-out;";
      wrapper.appendChild(layer);
      this.layers.push(layer);
    }

    return wrapper;
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "PHOTOS_UPDATED") {
      Log.info("[MMM-NextcloudPhotos2] " + payload.length + " photos update.");
      this.errorMessage = null;
      this.photos = payload;

      if (this.photos.length > 0 && this.currentIndex === -1) {
        this.updateDom(0);
        setTimeout(() => {
          this.showNextPhoto();
          this.startRotation();
        }, 500);
      }
    }

    if (notification === "AUTH_ERROR") {
      Log.error("[MMM-NextcloudPhotos2] Auth error: " + payload);
      this.errorMessage = payload;
      this.updateDom();
    }
  },

  getNextIndex: function () {
    if (this.photos.length === 0) return -1;

    if (this.config.order === "random") {
      if (this.photos.length === 1) return 0;
      var next;
      do {
        next = Math.floor(Math.random() * this.photos.length);
      } while (next === this.currentIndex);
      return next;
    }

    return (this.currentIndex + 1) % this.photos.length;
  },

  showNextPhoto: function () {
    if (this.photos.length === 0 || this.layers.length < 2) {
      Log.warn("[MMM-NextcloudPhotos2] showNextPhoto: zero photo.");
      return;
    }

    var nextIndex = this.getNextIndex();
    if (nextIndex === -1) return;

    this.currentIndex = nextIndex;
    var photo = this.photos[this.currentIndex];
    var self = this;
    var nextLayer = this.activeLayer === 0 ? 1 : 0;

    // Clean up previous preload image to free memory
    if (this._preloadImg) {
      this._preloadImg.onload = null;
      this._preloadImg.onerror = null;
      this._preloadImg.src = "";
      this._preloadImg = null;
    }

    var img = new Image();
    this._preloadImg = img;
    img.onload = function () {
      // Use stored layer references instead of querySelectorAll
      self.layers[nextLayer].style.backgroundImage = "url('" + photo.url + "')";
      self.layers[nextLayer].style.backgroundSize = self.config.backgroundSize;

      // Crossfade using inline opacity (avoids CSS class vs inline style conflict)
      self.layers[nextLayer].style.opacity = String(self.config.opacity);
      self.layers[self.activeLayer].style.opacity = "0";

      self.activeLayer = nextLayer;

      // Release preload image memory
      img.onload = null;
      img.onerror = null;
      self._preloadImg = null;

      Log.info("[MMM-NextcloudPhotos2] Show picture : " + photo.name);
    };
    img.onerror = function () {
      Log.error("[MMM-NextcloudPhotos2] Error from loading : " + photo.url);
      img.onload = null;
      img.onerror = null;
      self._preloadImg = null;
    };
    img.src = photo.url;
  },

  startRotation: function () {
    if (this.rotationTimer) clearInterval(this.rotationTimer);

    var self = this;
    this.rotationTimer = setInterval(function () {
      self.showNextPhoto();
    }, this.config.updateInterval);
  },
});
