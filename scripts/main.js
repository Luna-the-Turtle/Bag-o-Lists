// --- Logging Utility ---
function log(level, ...args) {
  const prefix = `[bag-of-lists] [${level}]`;
  if (level === 'error') {
    console.error(prefix, ...args);
  } else {
    console.log(prefix, ...args);
  }
}

function logError(message, error) {
  if (error instanceof Error) {
    console.error(`[bag-of-lists] [error] ${message}`, error.stack || error);
  } else {
    console.error(`[bag-of-lists] [error] ${message}`, error);
  }
}
// --- Socketlib Integration ---
Hooks.once('socketlib.ready', () => {
  const socket = socketlib.registerModule('bag-of-lists');
  // Register the update function for live sync
  socket.register('updateState', (newState) => {
    // Only update the shared data, preserve each user's active page
    const currentActivePageId = window._fr_temp_state?.activePageId;
    const currentActiveCustomEntryId = window._fr_custom_activeEntryId;
    window._fr_temp_state = foundry.utils.duplicate(newState);
    
    // Restore user's active page if it exists and is valid
    if (currentActivePageId && newState.pages?.some(p => p.id === currentActivePageId)) {
      window._fr_temp_state.activePageId = currentActivePageId;
    }
    const sharedEntries = window._fr_temp_state.customEntries?.filter?.(entry => entry.sharedToPlayers) ?? [];
    if (currentActiveCustomEntryId && sharedEntries.some(entry => entry.id === currentActiveCustomEntryId)) {
      window._fr_custom_activeEntryId = currentActiveCustomEntryId;
    } else {
      window._fr_custom_activeEntryId = sharedEntries[0]?.id ?? null;
    }
    
    if (game.factionTracker?.rendered) {
      game.factionTracker.render(true);
    }
  });
  
  // Register handler for player value changes (GM only)
  socket.register('playerValueChange', async (data) => {
    if (!game.user.isGM) return; // Only GM can save
    const { factionId, userId, newValue, pageId } = data || {};
    if (!factionId || !userId) return;

    const state = getState();
    const targetPageId = pageId || state.activePageId;
    const page = state.pages.find(p => p.id === targetPageId);

    if (page) {
      page.userRelations ||= {};
      page.userRelations[userId] ||= {};
      page.userRelations[userId][factionId] = newValue;
      resetAnnouncementDismissalsForPage(page);

      await saveState(state);

      // Broadcast the updated state to everyone (without activePageId)
      const latestState = getState();
      window.broadcastStateToPlayers(latestState);
    }
  });

  socket.register('playerDismissAnnouncement', async (data) => {
    if (!game.user.isGM) return;
    const { pageId, announcementId, userId } = data || {};
    if (!pageId || !announcementId || !userId || userId === 'gm') return;

    const state = getState();
    const page = state.pages.find(p => p.id === pageId);
    if (!page?.announcements) return;
    const announcement = page.announcements.find(a => a.id === announcementId);
    if (!announcement) return;
    if (!Array.isArray(announcement.targets) || !announcement.targets.includes(userId)) return;

    announcement.dismissedBy ||= {};
    announcement.dismissedBy[userId] = true;
    resetAnnouncementDismissalsForPage(page);

    await saveState(state);

    const latestState = getState();
    window.broadcastStateToPlayers(latestState);
  });
  // Player or GM requests to update faction background (GM authoritative)
  socket.register('updateFactionBackground', async (data) => {
    if (!game.user.isGM) return; // Only GM mutates state
    try {
      const { pageId, factionId, imgBgEnabled, imgBgClass } = data;
      const state = getState();
      const page = state.pages.find(p => p.id === (pageId || state.activePageId));
      if (!page) return;
      const faction = page.factions.find(f => f.id === factionId);
      if (!faction) return;
      if (typeof imgBgEnabled === 'boolean') faction.imgBgEnabled = imgBgEnabled;
      if (typeof imgBgClass === 'string') faction.imgBgClass = imgBgClass;
      await saveState(state);
      // Broadcast latest state
      const latestState = getState();
      // Do not force activePageId on players
      window.broadcastStateToPlayers(latestState);
      // Locally update temp state for GM
      window._fr_temp_state = latestState;
      if (game.factionTracker?.rendered) game.factionTracker.render(true);
    } catch (e) {
      logError('updateFactionBackground failed', e);
    }
  });

  socket.register('updateFactionImageConfig', async (data) => {
    if (!game.user.isGM) return;
    try {
      const { pageId, factionId, imgConfig } = data || {};
      const state = getState();
      const targetPageId = pageId || state.activePageId;
      const page = state.pages.find(p => p.id === targetPageId);
      if (!page) return;
      const faction = page.factions.find(f => f.id === factionId);
      if (!faction) return;
      faction.imgConfig = normalizeImageConfig(imgConfig);
      await saveState(state);
      const latest = getState();
      window.broadcastStateToPlayers(latest);
      window._fr_temp_state = latest;
      if (game.factionTracker?.rendered) game.factionTracker.render(true);
    } catch (e) {
      logError('updateFactionImageConfig failed', e);
    }
  });
  
  // Store socket reference for use in GM emit
  game.bagOfListsSocket = socket;
  
  // Helper function to broadcast state without activePageId (so players keep their own page)
  window.broadcastStateToPlayers = (state) => {
    if (game.user.isGM && game.bagOfListsSocket) {
      const stateCopy = foundry.utils.duplicate(state);
      // Remove activePageId so players keep their current page
      delete stateCopy.activePageId;
      game.bagOfListsSocket.executeForEveryone('updateState', stateCopy);
    }
  };
  if (typeof window._fr_custom_activeEntryId === 'undefined') {
    window._fr_custom_activeEntryId = null;
  }
  if (typeof window._fr_player_activeTab === 'undefined') {
    window._fr_player_activeTab = null;
  }
  if (!window._fr_custom_activePageMap || typeof window._fr_custom_activePageMap !== 'object') {
    window._fr_custom_activePageMap = {};
  }
  if (!Array.isArray(window._fr_lastAnnouncementRecipients)) {
    window._fr_lastAnnouncementRecipients = ['gm'];
  }
  if (typeof window._fr_lastAnnouncementSelectedId === 'undefined') {
    window._fr_lastAnnouncementSelectedId = null;
  }
});

Hooks.on('updateSetting', (setting, value) => {
  if (setting === 'bag-of-lists.state') {
    window._fr_temp_state = foundry.utils.duplicate(value);
    if (game.factionTracker?.rendered) {
      game.factionTracker.render(true);
    }
  }
});

Hooks.on('updateWorldSetting', (setting, value) => {
  if (setting === 'bag-of-lists.state') {
    window._fr_temp_state = foundry.utils.duplicate(value);
    if (game.factionTracker?.rendered) {
      game.factionTracker.render(true);
    }
  }
});
const MODULE_ID = "bag-of-lists";

/** ------- Settings & State ------- **/
Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "state", {
    scope: "world",
    config: false,
    type: Object,
    default: {
      pages: [
        {
          id: foundry.utils.randomID(),
          name: "Factions",
          factions: [],
          userRelations: {},
          announcements: []
        }
      ],
      activePageId: null, // will be set to first page on load
      customEntries: []
    }
  });
});

function getState() {
  // duplicate to avoid accidental in-place mutation of settings object
  const state = foundry.utils.duplicate(game.settings.get(MODULE_ID, "state"));
  // Remove legacy global arrays if present
  if (state.factions) delete state.factions;
  if (state.userRelations) delete state.userRelations;
  if (!Array.isArray(state.pages)) {
    state.pages = [];
  }
  for (const page of state.pages) {
    if (!Array.isArray(page.factions)) {
      page.factions = [];
    }
    if (!page.userRelations || typeof page.userRelations !== 'object') {
      page.userRelations = {};
    }
    if (!Array.isArray(page.announcements)) {
      page.announcements = [];
    }
    for (const announcement of page.announcements) {
      if (!Array.isArray(announcement.targets) || announcement.targets.length === 0) {
        announcement.targets = ['gm'];
      }
      if (!announcement.dismissedBy || typeof announcement.dismissedBy !== 'object') {
        announcement.dismissedBy = {};
      } else {
        for (const targetId of Object.keys(announcement.dismissedBy)) {
          if (targetId === 'gm' || !announcement.targets.includes(targetId)) {
            delete announcement.dismissedBy[targetId];
          }
        }
      }
      announcement.operator = announcement.operator === 'ge' ? 'ge' : 'le';
      if (typeof announcement.threshold === 'string') {
        const trimmed = announcement.threshold.trim();
        if (trimmed !== '') {
          const num = Number(trimmed);
          if (Number.isFinite(num)) announcement.threshold = num;
        }
      }
    }
  }
  // If no activePageId, set to first page
  if (!state.activePageId && state.pages.length) {
    state.activePageId = state.pages[0].id;
  }
  if (!Array.isArray(state.customEntries)) {
    state.customEntries = [];
  }
  return state;
}

async function saveState(state) {
  await game.settings.set(MODULE_ID, "state", state);
  // If GM, broadcast new state to all clients using socketlib (without activePageId)
  if (game.user?.isGM && game.bagOfListsSocket) {
    window.broadcastStateToPlayers(state);
  }
}

const PORTRAIT_EDITOR_SIZE = 320;
const PORTRAIT_MIN_SCALE = 0.5;
const PORTRAIT_DEFAULT_SCALE = 1;
const PORTRAIT_MAX_SCALE = 3;
const PORTRAIT_SCALE_STEP = 0.05;
const PORTRAIT_OFFSET_MARGIN = PORTRAIT_EDITOR_SIZE;

function defaultImageConfig() {
  return {
    scale: PORTRAIT_DEFAULT_SCALE,
    offsetX: 0,
    offsetY: 0,
    editorSize: PORTRAIT_EDITOR_SIZE
  };
}

function normalizeImageConfig(config) {
  const defaults = defaultImageConfig();
  if (!config || typeof config !== 'object') {
    return { ...defaults };
  }
  const editorSize = Number(config.editorSize) || PORTRAIT_EDITOR_SIZE;
  const scale = Number(config.scale);
  return {
    scale: Number.isFinite(scale) ? Math.max(PORTRAIT_MIN_SCALE, Math.min(PORTRAIT_MAX_SCALE, scale)) : PORTRAIT_DEFAULT_SCALE,
    offsetX: Number.isFinite(Number(config.offsetX)) ? Number(config.offsetX) : defaults.offsetX,
    offsetY: Number.isFinite(Number(config.offsetY)) ? Number(config.offsetY) : defaults.offsetY,
    editorSize
  };
}

function doesAnnouncementPassForTarget(announcement, page, targetId) {
  if (!announcement || !page || !targetId || targetId === 'gm') return false;
  if (!Array.isArray(announcement.targets) || !announcement.targets.includes(targetId)) return false;
  const thresholdNumeric = Number(announcement.threshold);
  if (!Number.isFinite(thresholdNumeric)) return false;
  const operatorKey = announcement.operator === 'ge' ? 'ge' : 'le';
  const relationValue = Number(page.userRelations?.[targetId]?.[announcement.factionId]);
  if (!Number.isFinite(relationValue)) return false;
  return operatorKey === 'ge' ? relationValue >= thresholdNumeric : relationValue <= thresholdNumeric;
}

function resetAnnouncementDismissalsForPage(page) {
  if (!page || !Array.isArray(page.announcements) || page.announcements.length === 0) return;
  for (const announcement of page.announcements) {
    if (!announcement || typeof announcement !== 'object') continue;
    if (!Array.isArray(announcement.targets) || announcement.targets.length === 0) continue;
    const dismissedBy = announcement.dismissedBy;
    if (!dismissedBy || typeof dismissedBy !== 'object') continue;
    for (const targetId of Object.keys(dismissedBy)) {
      if (targetId === 'gm') {
        delete dismissedBy[targetId];
        continue;
      }
      if (!announcement.targets.includes(targetId) || !doesAnnouncementPassForTarget(announcement, page, targetId)) {
        delete dismissedBy[targetId];
      }
    }
    if (Object.keys(dismissedBy).length === 0) {
      delete announcement.dismissedBy;
    }
  }
}

function applyImageTransforms(root = document) {
  const scope = root instanceof HTMLElement ? root : document;
  const images = scope.querySelectorAll?.('.fr-img-transformable');
  if (!images || images.length === 0) return;

  images.forEach((img) => {
    const applyTransform = () => {
      try {
        const container = img.closest('[data-viewport-size]');
        if (!container) return;
        const viewportSize = Number(container.dataset.viewportSize) || container.clientWidth || container.clientHeight || 48;
        const config = normalizeImageConfig({
          scale: Number(img.dataset.scale),
          offsetX: Number(img.dataset.offsetX),
          offsetY: Number(img.dataset.offsetY),
          editorSize: Number(img.dataset.editorSize)
        });
        const ratio = viewportSize / (config.editorSize || PORTRAIT_EDITOR_SIZE);
        const offsetX = (config.offsetX || 0) * ratio;
        const offsetY = (config.offsetY || 0) * ratio;
        const naturalWidth = img.naturalWidth || viewportSize;
        const naturalHeight = img.naturalHeight || viewportSize;
  const baseScale = Math.min(viewportSize / naturalWidth, viewportSize / naturalHeight) || 1;
  const scale = baseScale * (config.scale ?? PORTRAIT_DEFAULT_SCALE);

        img.style.position = 'absolute';
        img.style.left = '50%';
        img.style.top = '50%';
        img.style.transformOrigin = 'center center';
        img.style.transform = `translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY}px)) scale(${scale})`;
      } catch (err) {
        logError('Failed to apply image transform', err);
      }
    };

    if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
      applyTransform();
    } else {
      img.addEventListener('load', applyTransform, { once: true });
      img.addEventListener('error', () => {
        img.style.transform = '';
      }, { once: true });
    }
  });
}

function getPlayerVisiblePages(state, userId) {
  if (!state?.pages || state.pages.length === 0 || !userId) return [];
  return state.pages.filter((page) => {
    const factions = page.factions || [];
    if (factions.length === 0) return false;
    const relations = page.userRelations?.[userId];
    if (!relations) return false;
    return factions.some((faction) => {
      if (!Object.prototype.hasOwnProperty.call(relations, faction.id)) return false;
      const value = Number(relations[faction.id]);
      if (!Number.isFinite(value)) return false;
      if (value !== 0) return true;
      return !!faction.persistOnZero;
    });
  });
}

function getPlayerFactionValue(page, userId, faction) {
  const relations = page.userRelations?.[userId];
  if (!relations) {
    return { hasEntry: false, value: null };
  }
  const hasEntry = Object.prototype.hasOwnProperty.call(relations, faction.id);
  if (!hasEntry) {
    return { hasEntry: false, value: null };
  }
  const value = Number(relations[faction.id]);
  if (!Number.isFinite(value)) {
    return { hasEntry: false, value: null };
  }
  return { hasEntry: true, value };
}

function buildFactionDisplay(page, userId, faction) {
  const { hasEntry, value } = getPlayerFactionValue(page, userId, faction);
  if (!hasEntry) return null;
  if (value === 0 && !faction.persistOnZero) return null;
  const imgConfig = normalizeImageConfig(faction.imgConfig);
  const clamped = Math.max(-50, Math.min(50, Number(value) || 0));
  const pct = Math.min(1, Math.max(0, Math.abs(clamped) / 50));
  return {
    id: faction.id,
    name: faction.name,
    img: faction.img || "icons/svg/shield.svg",
    persistOnZero: !!faction.persistOnZero,
    playerControlled: faction.playerControlled ?? false,
    imgBgEnabled: faction.imgBgEnabled ?? false,
    imgBgClass: faction.imgBgClass || '',
    value: clamped,
    posWidth: (clamped > 0) ? Math.round(pct * 50) : 0,
    negWidth: (clamped < 0) ? Math.round(pct * 50) : 0,
    imgScale: imgConfig.scale,
    imgOffsetX: imgConfig.offsetX,
    imgOffsetY: imgConfig.offsetY,
    imgEditorSize: imgConfig.editorSize,
    pageId: page.id
  };
}

class PortraitEditorApp extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
  constructor({ pageId, factionId, imgSrc, imgConfig, parentApp } = {}) {
    super({ id: `bol-portrait-editor-${foundry.utils.randomID()}` });
    this.pageId = pageId;
    this.factionId = factionId;
    this.imgSrc = imgSrc;
    this.parentApp = parentApp;
    this._viewportSize = PORTRAIT_EDITOR_SIZE;
    this._state = this._initializeState(normalizeImageConfig(imgConfig));
    this._imageReady = false;
    this._dragging = false;
    this._pointerId = null;
    this._lastPointer = null;

    this._onZoomInputHandler = this._handleZoomInput.bind(this);
  this._onZoomInHandler = this._handleZoomIn.bind(this);
  this._onZoomOutHandler = this._handleZoomOut.bind(this);
    this._onWheelHandler = this._handleWheel.bind(this);
    this._onResetHandler = this._handleReset.bind(this);
    this._onSaveHandler = this._handleSave.bind(this);
    this._onCancelHandler = this._handleCancel.bind(this);
    this._onPointerDownHandler = this._handlePointerDown.bind(this);
    this._boundPointerMove = this._handlePointerMove.bind(this);
    this._boundPointerUp = this._handlePointerUp.bind(this);
  }

  _initializeState(config) {
    let offsetX = Number(config.offsetX) || 0;
    let offsetY = Number(config.offsetY) || 0;
  const editorSize = Number(config.editorSize) || PORTRAIT_EDITOR_SIZE;
    if (editorSize !== PORTRAIT_EDITOR_SIZE) {
      const ratio = PORTRAIT_EDITOR_SIZE / editorSize;
      offsetX *= ratio;
      offsetY *= ratio;
    }
    const scale = Number.isFinite(Number(config.scale)) ? Number(config.scale) : PORTRAIT_DEFAULT_SCALE;
    return {
      scale: Math.max(PORTRAIT_MIN_SCALE, Math.min(PORTRAIT_MAX_SCALE, scale)),
      offsetX,
      offsetY,
      editorSize: PORTRAIT_EDITOR_SIZE,
      baseScale: 1,
      naturalWidth: PORTRAIT_EDITOR_SIZE,
      naturalHeight: PORTRAIT_EDITOR_SIZE
    };
  }

  static DEFAULT_OPTIONS = {
    id: 'bol-portrait-editor',
    tag: 'form',
    window: {
      title: 'Token Portrait Editor',
      resizable: false,
      minimizable: false
    },
    position: {
      width: 640,
      height: 'auto'
    },
    actions: {},
    form: {
      handler: undefined,
      submitOnChange: false,
      closeOnSubmit: false
    }
  };

  static PARTS = {
    form: {
      template: 'modules/bag-of-lists/templates/portrait-editor.hbs'
    }
  };

  async _prepareContext() {
    return {
      imageSrc: this.imgSrc,
      viewportSize: this._viewportSize,
      scale: this._state.scale,
      zoomPercent: Math.round(this._state.scale * 100),
      offsetX: Math.round(this._state.offsetX),
      offsetY: Math.round(this._state.offsetY),
      minZoom: PORTRAIT_MIN_SCALE * 100,
      maxZoom: PORTRAIT_MAX_SCALE * 100,
      zoomStep: PORTRAIT_SCALE_STEP * 100
    };
  }

  _cacheElements() {
    this._viewportEl = this.element?.querySelector('.portrait-editor-viewport');
    this._imgFrame = this.element?.querySelector('.portrait-editor-frame');
    this._imgEl = this.element?.querySelector('.portrait-editor-img');
    this._zoomSlider = this.element?.querySelector('.portrait-editor-zoom-range');
    this._zoomLabel = this.element?.querySelector('.portrait-editor-zoom-value');
    this._offsetLabel = this.element?.querySelector('.portrait-editor-offset-value');
    this._resetButton = this.element?.querySelector('.portrait-editor-reset');
    this._saveButton = this.element?.querySelector('.portrait-editor-save');
    this._cancelButton = this.element?.querySelector('.portrait-editor-cancel');
    this._zoomInButton = this.element?.querySelector('[data-action="zoom-in"]');
    this._zoomOutButton = this.element?.querySelector('[data-action="zoom-out"]');
  }

  _attachEventListeners() {
    if (this._zoomSlider) {
      this._zoomSlider.min = String(PORTRAIT_MIN_SCALE * 100);
      this._zoomSlider.max = String(PORTRAIT_MAX_SCALE * 100);
      this._zoomSlider.step = String(Math.max(1, PORTRAIT_SCALE_STEP * 100));
      this._zoomSlider.value = String(Math.round(this._state.scale * 100));
      this._zoomSlider.addEventListener('input', this._onZoomInputHandler);
    }
    if (this._imgFrame) {
      this._imgFrame.addEventListener('pointerdown', this._onPointerDownHandler);
      this._imgFrame.addEventListener('wheel', this._onWheelHandler, { passive: false });
    }
    this._resetButton?.addEventListener('click', this._onResetHandler);
    this._saveButton?.addEventListener('click', this._onSaveHandler);
    this._cancelButton?.addEventListener('click', this._onCancelHandler);
    this._zoomInButton?.addEventListener('click', this._onZoomInHandler);
    this._zoomOutButton?.addEventListener('click', this._onZoomOutHandler);
  }

  _detachEventListeners() {
    this._zoomSlider?.removeEventListener('input', this._onZoomInputHandler);
    this._imgFrame?.removeEventListener('pointerdown', this._onPointerDownHandler);
    this._imgFrame?.removeEventListener('wheel', this._onWheelHandler);
    this._resetButton?.removeEventListener('click', this._onResetHandler);
    this._saveButton?.removeEventListener('click', this._onSaveHandler);
    this._cancelButton?.removeEventListener('click', this._onCancelHandler);
    this._zoomInButton?.removeEventListener('click', this._onZoomInHandler);
    this._zoomOutButton?.removeEventListener('click', this._onZoomOutHandler);
    window.removeEventListener('pointermove', this._boundPointerMove);
    window.removeEventListener('pointerup', this._boundPointerUp);
    window.removeEventListener('pointercancel', this._boundPointerUp);
  }

  _setupImage() {
    if (!this._imgEl) return;
    const handleLoad = () => {
      this._imageReady = true;
      const naturalWidth = this._imgEl.naturalWidth || PORTRAIT_EDITOR_SIZE;
      const naturalHeight = this._imgEl.naturalHeight || PORTRAIT_EDITOR_SIZE;
      this._state.naturalWidth = naturalWidth;
      this._state.naturalHeight = naturalHeight;
      this._state.baseScale = Math.min(this._viewportSize / naturalWidth, this._viewportSize / naturalHeight) || 1;
      const clamped = this._clampOffsets(this._state.offsetX, this._state.offsetY);
      this._state.offsetX = clamped.offsetX;
      this._state.offsetY = clamped.offsetY;
      this._applyStateToDom();
    };
    if (this._imgEl.complete && this._imgEl.naturalWidth > 0) {
      handleLoad();
    } else {
      this._imgEl.addEventListener('load', handleLoad, { once: true });
      this._imgEl.addEventListener('error', () => {
        ui.notifications?.error('Failed to load portrait image.');
      }, { once: true });
    }
  }

  _handleZoomInput(event) {
    const value = Number(event.currentTarget.value) || PORTRAIT_MIN_SCALE * 100;
    this._setScale(value / 100);
  }

  _handleWheel(event) {
    event.preventDefault();
    const direction = event.deltaY < 0 ? -1 : 1;
    const step = PORTRAIT_SCALE_STEP;
    this._setScale(this._state.scale - direction * step);
  }

  _handleZoomIn(event) {
    event.preventDefault();
    this._setScale(this._state.scale + PORTRAIT_SCALE_STEP);
  }

  _handleZoomOut(event) {
    event.preventDefault();
    this._setScale(this._state.scale - PORTRAIT_SCALE_STEP);
  }

  _handleReset(event) {
    event.preventDefault();
    this._state.scale = PORTRAIT_DEFAULT_SCALE;
    this._state.offsetX = 0;
    this._state.offsetY = 0;
    this._applyStateToDom();
  }

  async _handleSave(event) {
    event.preventDefault();
    try {
      const payload = {
        scale: Number(this._state.scale.toFixed(4)),
        offsetX: Number(this._state.offsetX.toFixed(2)),
        offsetY: Number(this._state.offsetY.toFixed(2)),
        editorSize: PORTRAIT_EDITOR_SIZE
      };
      await this._persistConfig(payload);
      this.close();
    } catch (err) {
      logError('Failed to save portrait configuration', err);
      ui.notifications?.error('Failed to save portrait changes.');
    }
  }

  _handleCancel(event) {
    event.preventDefault();
    this.close();
  }

  _handlePointerDown(event) {
    if (!this._imageReady) return;
    event.preventDefault();
    this._dragging = true;
    this._pointerId = event.pointerId;
    this._lastPointer = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    window.addEventListener('pointermove', this._boundPointerMove);
    window.addEventListener('pointerup', this._boundPointerUp);
    window.addEventListener('pointercancel', this._boundPointerUp);
  }

  _handlePointerMove(event) {
    if (!this._dragging || event.pointerId !== this._pointerId) return;
    event.preventDefault();
    const deltaX = event.clientX - this._lastPointer.x;
    const deltaY = event.clientY - this._lastPointer.y;
    this._lastPointer = { x: event.clientX, y: event.clientY };
    this._state.offsetX += deltaX;
    this._state.offsetY += deltaY;
    const clamped = this._clampOffsets(this._state.offsetX, this._state.offsetY);
    this._state.offsetX = clamped.offsetX;
    this._state.offsetY = clamped.offsetY;
    this._applyStateToDom();
  }

  _handlePointerUp(event) {
    if (event.pointerId !== this._pointerId) return;
    event.preventDefault();
    this._dragging = false;
    this._pointerId = null;
    this._lastPointer = null;
    this._imgFrame?.releasePointerCapture?.(event.pointerId);
    window.removeEventListener('pointermove', this._boundPointerMove);
    window.removeEventListener('pointerup', this._boundPointerUp);
    window.removeEventListener('pointercancel', this._boundPointerUp);
  }

  _setScale(newScale) {
    const clampedScale = Math.max(PORTRAIT_MIN_SCALE, Math.min(PORTRAIT_MAX_SCALE, newScale));
    this._state.scale = clampedScale;
    const clamped = this._clampOffsets(this._state.offsetX, this._state.offsetY);
    this._state.offsetX = clamped.offsetX;
    this._state.offsetY = clamped.offsetY;
    this._applyStateToDom();
  }

  _clampOffsets(offsetX, offsetY) {
    if (!this._imageReady) {
      return { offsetX, offsetY };
    }
    const displayWidth = this._state.naturalWidth * this._state.baseScale * this._state.scale;
    const displayHeight = this._state.naturalHeight * this._state.baseScale * this._state.scale;
    const extraMarginX = PORTRAIT_OFFSET_MARGIN;
    const extraMarginY = PORTRAIT_OFFSET_MARGIN;
    const maxOffsetX = Math.max(0, (displayWidth - this._viewportSize) / 2 + extraMarginX);
    const maxOffsetY = Math.max(0, (displayHeight - this._viewportSize) / 2 + extraMarginY);
    return {
      offsetX: Math.min(maxOffsetX, Math.max(-maxOffsetX, offsetX)),
      offsetY: Math.min(maxOffsetY, Math.max(-maxOffsetY, offsetY))
    };
  }

  _applyStateToDom() {
    if (!this._imgEl) return;
    this._imgEl.dataset.scale = String(this._state.scale);
    this._imgEl.dataset.offsetX = String(this._state.offsetX);
    this._imgEl.dataset.offsetY = String(this._state.offsetY);
    this._imgEl.dataset.editorSize = String(PORTRAIT_EDITOR_SIZE);
    applyImageTransforms(this.element);
    this._syncControls();
  }

  _syncControls() {
    if (this._zoomSlider) {
      this._zoomSlider.value = String(Math.round(this._state.scale * 100));
    }
    if (this._zoomLabel) {
      this._zoomLabel.textContent = `${Math.round(this._state.scale * 100)}%`;
    }
    if (this._offsetLabel) {
      this._offsetLabel.textContent = `x: ${Math.round(this._state.offsetX)}px, y: ${Math.round(this._state.offsetY)}px`;
    }
  }

  async _persistConfig(config) {
    if (game.user.isGM) {
      const state = getState();
      const page = state.pages?.find?.(p => p.id === this.pageId);
      if (!page) throw new Error('Page not found for portrait update');
      const faction = page.factions?.find?.(f => f.id === this.factionId);
      if (!faction) throw new Error('Faction not found for portrait update');
      faction.imgConfig = config;
      await saveState(state);
      const latest = getState();
      window._fr_temp_state = latest;
      if (this.parentApp?.rendered) {
        this.parentApp.render(true);
      }
    } else if (game.bagOfListsSocket) {
      game.bagOfListsSocket.executeAsGM('updateFactionImageConfig', {
        pageId: this.pageId,
        factionId: this.factionId,
        imgConfig: config
      });
    } else {
      ui.notifications?.warn('Unable to sync portrait changes without a GM online.');
    }
  }

  _onRender(context, options) {
    this._cacheElements();
    this._attachEventListeners();
    this._setupImage();
    this._applyStateToDom();
  }

  async close(options = {}) {
    this._detachEventListeners();
    return super.close(options);
  }
}

/** ------- Faction Tracker App (ApplicationV2) ------- **/
class FactionTrackerApp extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
  constructor(options = {}) {
    super(options);
    this._isDragging = false; // Track dragging state to prevent renders
  }
  /** Inject custom SVG icon into header after render */
  injectHeaderIcon() {
    setTimeout(() => {
      const header = this.element.querySelector('.window-header .window-title');
      if (header && !header.querySelector('.bol-header-icon')) {
        // Remove any existing text nodes so we can control layout
        while (header.firstChild) header.removeChild(header.firstChild);
        const wrapper = document.createElement('span');
        wrapper.style.display = 'flex';
        wrapper.style.alignItems = 'center';
        const img = document.createElement('img');
        img.src = 'modules/bag-of-lists/styles/backpack.svg';
        img.className = 'bol-header-icon';
        img.style.width = '22px';
        img.style.height = '22px';
        img.style.verticalAlign = 'middle';
        img.style.marginRight = '8px';
        const titleSpan = document.createElement('span');
        titleSpan.textContent = 'Bag o\' Lists';
        titleSpan.style.fontWeight = 'bold';
        titleSpan.style.fontSize = '1.1em';
        wrapper.appendChild(img);
        wrapper.appendChild(titleSpan);
        header.appendChild(wrapper);
      }
    }, 10);
  }
  static DEFAULT_OPTIONS = {
    id: "faction-tracker-app",
    tag: "form",
    window: {
      title: "Bag o' Lists",
      icon: null,
      resizable: true,
      minimizable: true
    },
    position: {
      width: 900,
      height: "auto"
    },
    actions: {},
    form: {
      handler: undefined,
      submitOnChange: false,
      closeOnSubmit: false
    }
  };

  static PARTS = {
    form: {
  template: "modules/bag-of-lists/templates/faction-tracker.hbs"
    }
  };

  /** Override render to prevent renders during drag operations and preserve scroll position */
  async render(force = false, options = {}) {
    if (this._isDragging && !force) {
      return this; // Block renders during drag operations
    }
    
    // Preserve scroll position during re-renders (but not during close)
    const isClosing = options.close || this._state === Application.RENDER_STATES.CLOSING;
    let preservedScrollTop = 0;
    
    if (!isClosing && this.rendered) {
      const scrollContainer = this.element?.querySelector('.fr-table-container') || this.element?.querySelector('.fr-grid-container');
      preservedScrollTop = scrollContainer ? scrollContainer.scrollTop : 0;
    }
    
    const result = await super.render(force, options);
    
    // Restore scroll position
    if (preservedScrollTop > 0 && !isClosing && this.element) {
      const newScrollContainer = this.element.querySelector('.fr-table-container') || this.element.querySelector('.fr-grid-container');
      if (newScrollContainer) {
        newScrollContainer.scrollTop = preservedScrollTop;
      }
    }
    
    return result;
  }

  /** Override close to ensure drag state is cleaned up */
  async close(options = {}) {
    // Reset drag state to prevent render blocking during close
    this._isDragging = false;
    
    // Clean up any stray drag elements
    const dragElements = document.querySelectorAll('.fr-drag-ghost, .fr-drop-placeholder, .fr-drag-hidden');
    dragElements.forEach(el => el.remove());
    
    return await super.close(options);
  }

  /** Build the template context. */
  async _prepareContext(options) {
    const isGM = !!game.user.isGM;
    // Use temp state if available, else get from settings
    const state = window._fr_temp_state || getState();
    if (!Array.isArray(state.customEntries)) {
      state.customEntries = [];
    }
    const players = (game.users?.contents ?? game.users).filter(u => !u.isGM);
    const customEntries = state.customEntries;
    const gmRecipients = [
      ...players.map(p => ({
        id: p.id,
        name: p.name,
        isCustom: false,
        isPlayer: true,
        sharedToPlayers: false
      })),
      ...customEntries.map(entry => ({
        id: entry.id,
        name: entry.name,
        isCustom: true,
        isPlayer: false,
        sharedToPlayers: !!entry.sharedToPlayers
      }))
    ];

    // Find active page
    let activePage = state.pages.find(p => p.id === state.activePageId) || state.pages[0];
    // Defensive: if no page, create one
    if (!activePage) {
      const newPage = {
        id: foundry.utils.randomID(),
        name: "Factions",
        factions: [],
        userRelations: {},
        announcements: []
      };
      state.pages.push(newPage);
      state.activePageId = newPage.id;
      await saveState(state);
      // refetch state after save
      const refreshed = getState();
      window._fr_temp_state = refreshed;
      return this._prepareContext(options);
    }

    // Only use per-page data
    const gmFactions = activePage.factions.map(f => {
      const imgConfig = normalizeImageConfig(f.imgConfig);
      const cells = gmRecipients.map(recipient => {
        const value = (activePage.userRelations?.[recipient.id]?.[f.id]) ?? 0;
        const clamped = Math.max(-50, Math.min(50, Number(value) || 0));
        const pct = Math.min(1, Math.max(0, Math.abs(clamped) / 50));
        
        return {
          userId: recipient.id,
          isCustom: recipient.isCustom,
          value: clamped,
          posWidth: (clamped > 0) ? Math.round(pct * 50) : 0,
          negWidth: (clamped < 0) ? Math.round(pct * 50) : 0
        };
      });
      return {
        id: f.id,
        name: f.name,
        img: f.img || "icons/svg/shield.svg",
        persistOnZero: !!f.persistOnZero,
        playerControlled: f.playerControlled ?? false,
        imgBgEnabled: f.imgBgEnabled ?? false,
        imgBgClass: f.imgBgClass || '',
        imgScale: imgConfig.scale,
        imgOffsetX: imgConfig.offsetX,
        imgOffsetY: imgConfig.offsetY,
        imgEditorSize: imgConfig.editorSize,
        cells
      };
    });

    activePage.announcements ||= [];
    const announcementTargets = activePage.factions.map(f => ({
      id: f.id,
      name: f.name
    }));
    const announcementAudienceOptions = [
      { id: 'gm', name: 'GM' },
      ...players.map(p => ({ id: p.id, name: p.name }))
    ];
    const userNameLookup = new Map([
      ['gm', 'GM'],
      ...players.map(p => [p.id, p.name])
    ]);

    const gmAnnouncements = activePage.announcements.map(announcement => {
      const targetFaction = activePage.factions.find(f => f.id === announcement.factionId);
      const operatorKey = announcement.operator === 'ge' ? 'ge' : 'le';
      const operatorSymbol = operatorKey === 'ge' ? '≥' : '≤';
      const numericThreshold = Number(announcement.threshold);
      const thresholdDisplay = Number.isFinite(numericThreshold) ? numericThreshold : (announcement.threshold ?? '');
      const targets = Array.isArray(announcement.targets) && announcement.targets.length ? announcement.targets : ['gm'];
      const targetNames = targets.map(t => userNameLookup.get(t) ?? 'Unknown');
      const display = `${targetFaction?.name ?? 'Unknown Item'} ${operatorSymbol} ${thresholdDisplay} : ${announcement.message ?? ''}`.trim();
      return {
        id: announcement.id,
        factionId: announcement.factionId,
        factionName: targetFaction?.name ?? 'Unknown Item',
        operatorKey,
        operatorSymbol,
        threshold: thresholdDisplay,
        thresholdNumeric: Number.isFinite(numericThreshold) ? numericThreshold : null,
        message: announcement.message ?? '',
        targets,
        targetNames,
        targetSummary: targetNames.join(', '),
        display
      };
    });

    let announcementSelectedId = window._fr_lastAnnouncementSelectedId;
    if (!gmAnnouncements.some(ann => ann.id === announcementSelectedId)) {
      announcementSelectedId = gmAnnouncements[0]?.id ?? null;
      window._fr_lastAnnouncementSelectedId = announcementSelectedId;
    }

    const gmAnnouncementAlerts = [];
    for (const ann of gmAnnouncements) {
      if (ann.thresholdNumeric === null) continue;
      const hits = [];
      for (const targetId of ann.targets) {
        if (targetId === 'gm') continue;
        const rawValue = activePage.userRelations?.[targetId]?.[ann.factionId];
        const value = Number(rawValue);
        if (!Number.isFinite(value)) continue;
        const passes = ann.operatorKey === 'ge' ? value >= ann.thresholdNumeric : value <= ann.thresholdNumeric;
        if (passes) {
          hits.push({ targetId, value });
        }
      }
      if (!hits.length) continue;
      const detailText = hits.map(hit => {
        const name = userNameLookup.get(hit.targetId) ?? 'Unknown';
        return `${name} (${hit.value})`;
      }).join(', ');
      gmAnnouncementAlerts.push({
        id: ann.id,
        display: ann.display,
        details: detailText ? `Triggered by: ${detailText}` : ''
      });
    }

    if (!isGM) {
      const me = game.user;
      const playerPages = getPlayerVisiblePages(state, me.id);
      const sharedEntries = customEntries.filter(entry => entry.sharedToPlayers);
      const sharedCustomViews = sharedEntries.map(entry => {
        const pages = state.pages.map(page => {
          const factions = page.factions.map(f => buildFactionDisplay(page, entry.id, f)).filter(Boolean);
          if (factions.length === 0) return null;
          return {
            id: page.id,
            name: page.name,
            factions
          };
        }).filter(Boolean);
        return {
          id: entry.id,
          name: entry.name,
          pages
        };
      }).filter(Boolean);

      const playerTabs = [
        ...playerPages.map(page => ({
          key: `page:${page.id}`,
          type: 'page',
          id: page.id,
          name: page.name
        })),
        ...sharedCustomViews.map(view => ({
          key: `custom:${view.id}`,
          type: 'custom',
          id: view.id,
          name: view.name
        }))
      ];

      let activeTabKey = window._fr_player_activeTab;
      if (!playerTabs.some(tab => tab.key === activeTabKey)) {
        activeTabKey = playerTabs[0]?.key ?? null;
        window._fr_player_activeTab = activeTabKey;
      }

      const activeTab = playerTabs.find(tab => tab.key === activeTabKey) || null;
      let activeTabType = activeTab?.type ?? null;
      let activePageId = null;
      let pageName = null;
      let myFactions = [];
      let activeCustomEntryId = null;
      let customSubTabs = [];
      let customActivePage = null;
      let announcementAlerts = [];

      if (activeTabType === 'page') {
        activePageId = activeTab.id;
        const activePlayerPage = playerPages.find(p => p.id === activePageId) || playerPages[0] || null;
        if (activePlayerPage) {
          pageName = activePlayerPage.name;
          myFactions = activePlayerPage.factions.map(f => buildFactionDisplay(activePlayerPage, me.id, f)).filter(Boolean);
          activePageId = activePlayerPage.id;
          const basePage = state.pages.find(p => p.id === activePlayerPage.id);
          if (basePage?.announcements?.length) {
            for (const announcement of basePage.announcements) {
              const targets = Array.isArray(announcement.targets) && announcement.targets.length ? announcement.targets : ['gm'];
              if (!targets.includes(me.id)) continue;
              const operatorKey = announcement.operator === 'ge' ? 'ge' : 'le';
              const operatorSymbol = operatorKey === 'ge' ? '≥' : '≤';
              const thresholdNumeric = Number(announcement.threshold);
              if (!Number.isFinite(thresholdNumeric)) continue;
              const faction = basePage.factions.find(f => f.id === announcement.factionId);
              if (!faction) continue;
              const rawValue = basePage.userRelations?.[me.id]?.[announcement.factionId];
              const value = Number(rawValue);
              if (!Number.isFinite(value)) continue;
              const passes = operatorKey === 'ge' ? value >= thresholdNumeric : value <= thresholdNumeric;
              if (!passes) continue;
              if (announcement.dismissedBy?.[me.id]) continue;
              const message = `${faction.name} ${operatorSymbol} ${thresholdNumeric} : ${announcement.message ?? ''}`.trim();
              announcementAlerts.push({
                id: announcement.id,
                display: message,
                value,
                pageId: basePage.id
              });
            }
          }
        } else {
          activePageId = null;
        }
        window._fr_custom_activeEntryId = null;
      } else if (activeTabType === 'custom') {
        activeCustomEntryId = activeTab.id;
        window._fr_custom_activeEntryId = activeCustomEntryId;
        const activeView = sharedCustomViews.find(view => view.id === activeCustomEntryId) || null;
        const pageMap = window._fr_custom_activePageMap || {};
        if (activeView) {
          let activeCustomPageId = pageMap[activeCustomEntryId];
          if (!activeView.pages.some(p => p.id === activeCustomPageId)) {
            activeCustomPageId = activeView.pages[0]?.id ?? null;
            window._fr_custom_activePageMap[activeCustomEntryId] = activeCustomPageId;
          }
          customSubTabs = activeView.pages.map(page => ({
            id: page.id,
            name: page.name,
            isActive: page.id === activeCustomPageId
          }));
          customActivePage = activeView.pages.find(page => page.id === activeCustomPageId) || null;
        }
      } else {
        window._fr_custom_activeEntryId = null;
      }

      return {
        isGM,
        pages: playerPages,
        playerTabs,
        activeTabKey,
        activeTabType,
        activePageId,
        myFactions,
        pageName,
        activeCustomEntryId,
        customSubTabs,
        customActivePage,
        announcementAlerts,
        backgroundOptions: [
          { class: 'fr-bg-gradient-blue', label: 'Blue Gradient' },
          { class: 'fr-bg-gradient-sunset', label: 'Sunset Gradient' },
          { class: 'fr-bg-gradient-purple', label: 'Purple Gradient' },
          { class: 'fr-bg-gradient-forest', label: 'Forest Gradient' },
          { class: 'fr-bg-gradient-fire', label: 'Fire Gradient' },
          { class: 'fr-bg-solid-red', label: 'Solid Red' },
          { class: 'fr-bg-solid-blue', label: 'Solid Blue' },
          { class: 'fr-bg-solid-green', label: 'Solid Green' },
          { class: 'fr-bg-solid-gold', label: 'Solid Gold' },
          { class: 'fr-bg-solid-black', label: 'Solid Black' },
          { class: 'fr-bg-solid-purple', label: 'Solid Purple' }
        ]
      };
    }

    // GM view includes players list, faction x player matrix, and all pages for tabs
    return {
      isGM,
      recipients: gmRecipients,
      factions: gmFactions,
      pages: state.pages,
      activePageId: state.activePageId,
      pageName: activePage.name,
      announcementTargets,
      announcementAudienceOptions,
      announcementSavedList: gmAnnouncements,
  announcementSelectedId,
      gmAnnouncementAlerts,
      hasCustomEntries: customEntries.length > 0,
      backgroundOptions: [
        { class: 'fr-bg-gradient-blue', label: 'Blue Gradient' },
        { class: 'fr-bg-gradient-sunset', label: 'Sunset Gradient' },
        { class: 'fr-bg-gradient-purple', label: 'Purple Gradient' },
        { class: 'fr-bg-gradient-forest', label: 'Forest Gradient' },
        { class: 'fr-bg-gradient-fire', label: 'Fire Gradient' },
        { class: 'fr-bg-solid-red', label: 'Solid Red' },
        { class: 'fr-bg-solid-blue', label: 'Solid Blue' },
        { class: 'fr-bg-solid-green', label: 'Solid Green' },
        { class: 'fr-bg-solid-gold', label: 'Solid Gold' },
        { class: 'fr-bg-solid-black', label: 'Solid Black' },
        { class: 'fr-bg-solid-purple', label: 'Solid Purple' }
      ]
    };
  }

  _onRender(context, options) {
    const html = this.element;
    const $html = $(html);
    
    // Player: Up/down arrow handlers for playerControlled items
    $html.find('.fr-arrow-up').on('click', async (ev) => {
      const button = ev.currentTarget;
      const fid = button.dataset.fid;
      const state = window._fr_temp_state || getState();
      const me = game.user;
      const pageId = button.dataset.pageid || state.activePageId;
      // Find active page and faction
      const page = (state.pages || []).find(p => p.id === pageId);
      if (!page) return;
      const faction = page.factions.find(f => f.id === fid);
      if (!faction || !faction.playerControlled) return;
      page.userRelations ||= {};
      page.userRelations[me.id] ||= {};
      let v = Number(page.userRelations[me.id][fid]) || 0;
      v = Math.min(50, v + 1);
      page.userRelations[me.id][fid] = v;
      if (pageId) {
        state.activePageId = pageId;
      }
      
      // Save state to settings (if GM) or sync to GM
      if (game.user.isGM) {
        await saveState(state);
        // Broadcast to players (without activePageId)
        window.broadcastStateToPlayers(state);
      } else {
        // Sync to GM via socketlib - GM will save it
        if (game.bagOfListsSocket) {
          game.bagOfListsSocket.executeAsGM('playerValueChange', {
            factionId: fid,
            userId: me.id,
            newValue: v,
            pageId
          });
        }
      }
      
      window._fr_temp_state = state;
      this.render(true);
    });
    // --- Dropdown portaling for color picker in table view ---
    // Only apply in GM/table view
    if ($html.find('.fr-table-container').length) {
      $html.find('.fr-bg-selector').off('click').on('click', function (e) {
        e.stopPropagation();
        const button = this;
        // Close any open dropdowns first
        $('.fr-bg-dropdown.open').each((_, el) => {
          $(el).find('.fr-bg-dropdown-content').css('display', '');
        });
        $('.fr-bg-dropdown.open').removeClass('open');
        $('.fr-bg-dropdown-portal').remove();
        // Open the dropdown
        const dropdown = $(button).siblings('.fr-bg-dropdown-content').first();
        if (!dropdown.length) return;
        // Portal the dropdown to the closest .fr-table-container
        let tableContainer = button.closest('.fr-table-container');
        if (!tableContainer) tableContainer = document.body;
        // Clone the dropdown for portaling
        const portalDropdown = dropdown.clone(true, true).addClass('fr-bg-dropdown-portal');
        // Remove any existing portal dropdowns
        $(tableContainer).find('.fr-bg-dropdown-portal').remove();
        const restoreOriginal = () => {
          dropdown.css('display', '');
        };
        dropdown.css('display', 'none');
        // Calculate position
        const containerRect = tableContainer.getBoundingClientRect();
        const btnRect = button.getBoundingClientRect();
        const top = btnRect.top - containerRect.top + tableContainer.scrollTop + button.offsetHeight;
        const left = btnRect.left - containerRect.left + tableContainer.scrollLeft;
        portalDropdown.css({
          position: 'absolute',
          top: top + 'px',
          left: left + 'px',
          zIndex: 20000,
          minWidth: dropdown.outerWidth() + 'px',
          display: 'block'
        });
        $(tableContainer).append(portalDropdown);
        // Mark as open for styling
        $(button).closest('.fr-bg-dropdown').addClass('open');
        // Close on click outside
        $(document).one('mousedown.fr-bg-dropdown', function (evt) {
          if (!portalDropdown[0].contains(evt.target) && !button.contains(evt.target)) {
            restoreOriginal();
            portalDropdown.remove();
            $(button).closest('.fr-bg-dropdown').removeClass('open');
          }
        });
        // Handle option click
        portalDropdown.find('.fr-bg-option').on('click', function () {
          restoreOriginal();
          portalDropdown.remove();
          $(button).closest('.fr-bg-dropdown').removeClass('open');
        });
      });
    }

    $html.find('.fr-arrow-down').on('click', async (ev) => {
      const button = ev.currentTarget;
      const fid = button.dataset.fid;
      const state = window._fr_temp_state || getState();
      const me = game.user;
      const pageId = button.dataset.pageid || state.activePageId;
      // Find active page and faction
      const page = (state.pages || []).find(p => p.id === pageId);
      if (!page) return;
      const faction = page.factions.find(f => f.id === fid);
      if (!faction || !faction.playerControlled) return;
      page.userRelations ||= {};
      page.userRelations[me.id] ||= {};
      let v = Number(page.userRelations[me.id][fid]) || 0;
      v = Math.max(-50, v - 1);
      page.userRelations[me.id][fid] = v;
      if (pageId) {
        state.activePageId = pageId;
      }
      
      // Save state to settings (if GM) or sync to GM
      if (game.user.isGM) {
        await saveState(state);
        // Broadcast to players (without activePageId)
        window.broadcastStateToPlayers(state);
      } else {
        // Sync to GM via socketlib - GM will save it
        if (game.bagOfListsSocket) {
          game.bagOfListsSocket.executeAsGM('playerValueChange', {
            factionId: fid,
            userId: me.id,
            newValue: v,
            pageId
          });
        }
      }
      
      window._fr_temp_state = state;
      this.render(true);
    });

    $html.find('.fr-announcement-dismiss').on('click', async (ev) => {
      ev.preventDefault();
      const button = ev.currentTarget;
      const announcementId = button.dataset.announcementId;
      const pageId = button.dataset.pageid;
      if (!announcementId || !pageId) return;
      const currentUserId = game.user.id;

      if (game.user.isGM) {
        const state = getState();
        const page = state.pages.find(p => p.id === pageId);
        if (!page) return;
        const announcement = page.announcements?.find?.(ann => ann.id === announcementId);
        if (!announcement) return;
        announcement.dismissedBy ||= {};
        if (currentUserId !== 'gm') {
          announcement.dismissedBy[currentUserId] = true;
        }
        resetAnnouncementDismissalsForPage(page);
        await saveState(state);
        const latestState = getState();
        window._fr_temp_state = latestState;
        this.render(true);
        return;
      }

      const hasSocket = !!game.bagOfListsSocket;
      if (hasSocket) {
        button.disabled = true;
      }

      const localState = window._fr_temp_state;
      const localPage = localState?.pages?.find?.(p => p.id === pageId);
      const localAnnouncement = localPage?.announcements?.find?.(ann => ann.id === announcementId);
      if (localAnnouncement) {
        localAnnouncement.dismissedBy ||= {};
        localAnnouncement.dismissedBy[currentUserId] = true;
      }
      this.render(true);

      if (hasSocket) {
        try {
          await game.bagOfListsSocket.executeAsGM('playerDismissAnnouncement', {
            announcementId,
            pageId,
            userId: currentUserId
          });
        } catch (err) {
          logError('playerDismissAnnouncement failed', err);
          ui.notifications?.error?.('Failed to dismiss announcement. Please try again.');
        } finally {
          if (button.isConnected) {
            button.disabled = false;
          }
        }
      } else {
        ui.notifications?.warn?.('Dismissal did not reach the GM—socket connection unavailable.');
      }
    });
    // GM: Toggle playerControlled for a faction
    $html.find('.fr-player-control').on('change', async (ev) => {
      const fid = ev.currentTarget.dataset.fid;
      const checked = ev.currentTarget.checked;
      const state = getState();
      const page = state.pages.find(p => p.id === state.activePageId);
      if (page) {
        const faction = page.factions.find(f => f.id === fid);
        if (faction) {
          faction.playerControlled = checked;
          await saveState(state);
          
          // Fetch latest state and use for next render
          const latestState = getState();
          window._fr_temp_state = latestState;
          this.render(true);
        }
      }
    });
    
    // Detach previous event handlers before re-attaching
    $html.off('keydown', '.fr-val');
    $html.off('keydown', '#fr-new-name');
    $html.off('keydown', '.fr-rename-input');
    $html.off('keydown', '#fr-new-custom-name');
    $html.find('.fr-tab').off('click');
    $html.find('#fr-add-page').off('click');
    $html.find('.fr-rename-page').off('click');
    $html.off('input', '.fr-rename-input');
    $html.off('blur change', '.fr-rename-input');
    $html.find('#fr-del-page').off('click');
    $html.find('#fr-add').off('click');
    $html.find('#fr-new-name').off('keydown');
    $html.find('#fr-add-custom').off('click');
  $html.find('#fr-announcement-operator').off('click');
  $html.find('#fr-announcement-add').off('click');
  $html.find('#fr-announcement-message').off('keydown');
  $html.find('#fr-announcement-threshold').off('keydown');
  $html.find('#fr-announcement-recipients').off('change');
    $html.find('#fr-announcement-saved').off('change');
    $html.find('#fr-announcement-delete').off('click');
    $html.find('.fr-del').off('click');
    $html.find('.fr-del-custom').off('click');
  $html.find('.fr-img').off('click');
  $html.find('.fr-img-edit').off('click');
    $html.find('.fr-val').off('change blur');
    $html.find('.fr-share-custom').off('click');
    $html.find('.fr-custom-subtab').off('click');

      // GM: Toggle persistOnZero for an item
      $html.find('.fr-persist').on('change', async (ev) => {
        const fid = ev.currentTarget.dataset.fid;
        const checked = ev.currentTarget.checked;
        const state = getState();
        const page = state.pages.find(p => p.id === state.activePageId);
        if (page) {
          const faction = page.factions.find(f => f.id === fid);
          if (faction) {
            faction.persistOnZero = checked;
            await saveState(state);
            // Fetch latest state and use for next render
            const latestState = getState();
            window._fr_temp_state = latestState;
            this.render(true);
          }
        }
      });

    // GM: Delete tab for a specific player (remove all their values for active page)
    $html.find('.fr-del-tab').on('click', async (ev) => {
      const pageId = ev.currentTarget.dataset.pageid;
      const userId = ev.currentTarget.dataset.uid;
      const state = getState();
      const page = state.pages.find(p => p.id === pageId);
      if (page && page.userRelations?.[userId]) {
        // Remove all values for this player on this page
        delete page.userRelations[userId];
        await saveState(state);
        // Remove tab from player view by updating temp state
        const latestState = getState();
        window._fr_temp_state = latestState;
        if (game.user.isGM && game.socket) {
          console.log('[FactionTracker] socket emit (tab delete)', latestState);
          game.socket.emit('module.bag-of-lists', latestState, {broadcast: true});
        }
        this.render(true);
      }
    });

    $html.find('.fr-del-custom').on('click', async (ev) => {
      if (!game.user.isGM) return;
      ev.preventDefault();
      const customId = ev.currentTarget.dataset.customid;
      if (!customId) return;
      const state = getState();
      state.customEntries ||= [];
      const index = state.customEntries.findIndex(entry => entry.id === customId);
      if (index === -1) return;
      state.customEntries.splice(index, 1);
      for (const page of state.pages ?? []) {
        if (page.userRelations?.[customId]) {
          delete page.userRelations[customId];
        }
      }
      await saveState(state);
      const latestState = getState();
      window._fr_temp_state = latestState;
      if (window._fr_custom_activeEntryId === customId) {
        const sharedEntries = latestState.customEntries?.filter(entry => entry.sharedToPlayers) ?? [];
        window._fr_custom_activeEntryId = sharedEntries[0]?.id ?? null;
      }
      this.render(true);
    });

    $html.find('.fr-share-custom').on('click', async (ev) => {
      if (!game.user.isGM) return;
      ev.preventDefault();
      const customId = ev.currentTarget.dataset.customid;
      if (!customId) return;
      const state = getState();
      state.customEntries ||= [];
      const entry = state.customEntries.find(e => e.id === customId);
      if (!entry) return;
      const originalShared = !!entry.sharedToPlayers;
      const nextShared = !originalShared;
      entry.sharedToPlayers = nextShared;
      await saveState(state);
      const latestState = getState();
      window._fr_temp_state = latestState;
      const sharedEntries = latestState.customEntries?.filter(e => e.sharedToPlayers) ?? [];
      if (!nextShared && window._fr_custom_activeEntryId === customId) {
        window._fr_custom_activeEntryId = sharedEntries[0]?.id ?? null;
      } else if (nextShared && !window._fr_custom_activeEntryId) {
        window._fr_custom_activeEntryId = customId;
      }
      this.render(true);
    });

    // Pressing Enter in .fr-val input triggers blur/submit
    $html.on('keydown', '.fr-val', function(ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        ev.currentTarget.blur();
      }
    });
    // Pressing Enter in New "Create a Bag!" input triggers addItem
    $html.on('keydown', '#fr-new-name', function(ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        $html.find('#fr-add').click();
      }
    });
    // Pressing Enter in rename input triggers blur/submit
    $html.on('keydown', '.fr-rename-input', function(ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        ev.currentTarget.blur();
      }
    });

    // Tab switching
    $html.find('.fr-tab').on('click', async (ev) => {
      const tabType = ev.currentTarget.dataset.type || 'page';
      const pageId = ev.currentTarget.dataset.pageid;
      const customId = ev.currentTarget.dataset.customid;
      const isGM = !!game.user.isGM;

      if (!isGM && tabType === 'custom') {
        if (!customId) return;
        window._fr_player_activeTab = `custom:${customId}`;
        window._fr_custom_activeEntryId = customId;
        this.render(true);
        return;
      }

      if (!pageId) return;

      if (isGM) {
        // GM updates global state
        const state = getState();
        if (state.activePageId !== pageId) {
          state.activePageId = pageId;
          await saveState(state);
          // Fetch latest state from settings and use for next render
          const latestState = getState();
          window._fr_temp_state = latestState;
          this.render(true);
        }
      } else {
        const me = game.user;
        const baseState = window._fr_temp_state || getState();
        const playerPages = getPlayerVisiblePages(baseState, me.id);
        if (playerPages.length === 0) {
          window._fr_temp_state = { ...baseState, activePageId: null };
          window._fr_player_activeTab = null;
          this.render(true);
          return;
        }
        const nextActiveId = playerPages.some(p => p.id === pageId)
          ? pageId
          : playerPages[0].id;
        window._fr_temp_state = {
          ...baseState,
          activePageId: nextActiveId
        };
        window._fr_player_activeTab = `page:${nextActiveId}`;
        window._fr_custom_activeEntryId = null;
        this.render(true);
      }
    });

    $html.find('#fr-add-page').on('click', async () => {
      const state = getState();
      const newPage = {
        id: foundry.utils.randomID(),
        name: `Tracker ${state.pages.length + 1}`,
        factions: [],
        userRelations: {},
        announcements: []
      };
      log('info', 'Adding new page', newPage);
      state.pages.push(newPage);
      state.activePageId = newPage.id;
      state.pendingRenamePageId = newPage.id;
      await saveState(state);
      // Fetch latest state from settings and use for next render
      const latestState = getState();
      window._fr_temp_state = latestState;
      this.render(true);
    });
    // After render, if pendingRenamePageId is set, show and focus the rename input for that page
    const state = getState();
    if (state.pendingRenamePageId) {
      setTimeout(() => {
        const $newInput = $(this.element).find(`.fr-rename-input[data-pageid="${state.pendingRenamePageId}"]`);
        const $renameBtn = $(this.element).find(`.fr-rename-page[data-pageid="${state.pendingRenamePageId}"]`);
        if ($newInput.length && $renameBtn.length) {
          $renameBtn.hide();
          $newInput.show().focus();
        }
      }, 50);
    }

    const addCustomEntry = async () => {
      if (!game.user.isGM) return;
      const nameInput = $html.find('#fr-new-custom-name')[0];
      const name = nameInput?.value?.trim();
      if (!name) {
        return ui.notifications?.warn('Enter a custom entry name.');
      }
      const state = getState();
      state.customEntries ||= [];
      const newEntry = {
        id: `custom-${foundry.utils.randomID()}`,
        name,
        sharedToPlayers: false
      };
      state.customEntries.push(newEntry);
      await saveState(state);
      const latestState = getState();
      window._fr_temp_state = latestState;
      if (nameInput) nameInput.value = '';
      this.render(true);
    };

    $html.find('#fr-add-custom').on('click', (ev) => {
      ev.preventDefault();
      addCustomEntry();
    });
    $html.find('#fr-new-custom-name').on('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        addCustomEntry();
      }
    });

    const recipientsSelectEl = $html.find('#fr-announcement-recipients')[0];
    if (recipientsSelectEl) {
      const lastRecipients = Array.isArray(window._fr_lastAnnouncementRecipients) && window._fr_lastAnnouncementRecipients.length
        ? window._fr_lastAnnouncementRecipients
        : ['gm'];
      const allowedValues = new Set(Array.from(recipientsSelectEl.options).map(opt => opt.value));
      const appliedValues = lastRecipients.filter(value => allowedValues.has(value));
      const selectionSet = new Set(appliedValues.length ? appliedValues : ['gm']);
      for (const option of recipientsSelectEl.options) {
        option.selected = selectionSet.has(option.value);
      }
      window._fr_lastAnnouncementRecipients = Array.from(selectionSet);
      $html.find('#fr-announcement-recipients').on('change', (ev) => {
        const select = ev.currentTarget;
        window._fr_lastAnnouncementRecipients = Array.from(select.selectedOptions).map(opt => opt.value);
      });
    }

    $html.find('#fr-announcement-operator').on('click', (ev) => {
      const button = ev.currentTarget;
      const current = button.dataset.operator === 'ge' ? 'ge' : 'le';
      const next = current === 'le' ? 'ge' : 'le';
      button.dataset.operator = next;
      button.textContent = next === 'ge' ? '≥' : '≤';
    });

    const addAnnouncement = async () => {
      if (!game.user.isGM) return;
      await this._commitPendingFactionValues($html);
      const selectEl = $html.find('#fr-announcement-target')[0];
      const recipientsSelect = $html.find('#fr-announcement-recipients')[0];
      const thresholdInput = $html.find('#fr-announcement-threshold')[0];
      const messageInput = $html.find('#fr-announcement-message')[0];
      const operatorButton = $html.find('#fr-announcement-operator')[0];
      const factionId = selectEl?.value;
      const operator = operatorButton?.dataset.operator === 'ge' ? 'ge' : 'le';
      const thresholdValueRaw = thresholdInput?.value ?? '';
      const thresholdValue = typeof thresholdValueRaw === 'string' ? thresholdValueRaw.trim() : String(thresholdValueRaw ?? '');
      if (thresholdValue === '') {
        return ui.notifications?.warn('Enter a numeric threshold for the announcement.');
      }
      const threshold = Number(thresholdValue);
      const message = messageInput?.value?.trim() ?? '';
      const targets = Array.from(recipientsSelect?.selectedOptions ?? []).map(opt => opt.value);

      if (!factionId) {
        return ui.notifications?.warn('Select an item to watch before adding an announcement.');
      }
      if (!Number.isFinite(threshold)) {
        return ui.notifications?.warn('Enter a numeric threshold for the announcement.');
      }
      if (!message) {
        return ui.notifications?.warn('Add a short message so players know what the alert means.');
      }
      if (!targets.length) {
        return ui.notifications?.warn('Select at least one recipient for the announcement.');
      }

  const state = getState();
      const page = state.pages.find(p => p.id === state.activePageId);
      if (!page) {
        return ui.notifications?.error('Unable to find the active tracker page for this announcement.');
      }
      page.announcements ||= [];
      const newAnnouncementId = `announcement-${foundry.utils.randomID()}`;
      page.announcements.push({
        id: newAnnouncementId,
        factionId,
        operator,
        threshold,
        message,
        targets,
        dismissedBy: {}
      });

      window._fr_lastAnnouncementRecipients = targets.slice();
      window._fr_lastAnnouncementSelectedId = newAnnouncementId;

      await saveState(state);
      const latestState = getState();
      window._fr_temp_state = latestState;
      if (messageInput) messageInput.value = '';
      if (thresholdInput) thresholdInput.value = '';
      this.render(true);
    };

    $html.find('#fr-announcement-add').on('click', (ev) => {
      ev.preventDefault();
      addAnnouncement();
    });

    $html.find('#fr-announcement-message').on('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        addAnnouncement();
      }
    });

    $html.find('#fr-announcement-threshold').on('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        addAnnouncement();
      }
    });

    const refreshAnnouncementControls = () => {
      const selectEl = $html.find('#fr-announcement-saved')[0];
      const deleteBtn = $html.find('#fr-announcement-delete')[0];
      if (!deleteBtn) return;
      const hasValidOption = !!(selectEl && selectEl.value);
      deleteBtn.disabled = !hasValidOption;
    };

    refreshAnnouncementControls();

    $html.find('#fr-announcement-saved').on('change', (ev) => {
      const select = ev.currentTarget;
      window._fr_lastAnnouncementSelectedId = select?.value || null;
      refreshAnnouncementControls();
    });

    $html.find('#fr-announcement-delete').on('click', async (ev) => {
      if (!game.user.isGM) return;
      ev.preventDefault();
      const selectEl = $html.find('#fr-announcement-saved')[0];
      const announcementId = selectEl?.value;
      if (!announcementId) {
        return ui.notifications?.warn('Select a saved announcement before deleting.');
      }
      const state = getState();
      const page = state.pages.find(p => p.id === state.activePageId);
      if (!page?.announcements) return;
      const index = page.announcements.findIndex(a => a.id === announcementId);
      if (index === -1) return;
      page.announcements.splice(index, 1);
  const nextSelection = page.announcements[index] ?? page.announcements[index - 1] ?? null;
  window._fr_lastAnnouncementSelectedId = nextSelection?.id ?? null;
      await saveState(state);
      const latestState = getState();
      window._fr_temp_state = latestState;
      this.render(true);
    });

    // Rename page
    $html.find('.fr-rename-page').on('click', function(ev) {
      const pageId = ev.currentTarget.dataset.pageid;
      log('info', 'Rename page clicked', { pageId });
      $html.find(`.fr-rename-input[data-pageid="${pageId}"]`).show().focus();
      $html.find(`.fr-rename-page[data-pageid="${pageId}"]`).hide();
    });
    // Live update tab label and state as user types (input event)
    $html.on('input', '.fr-rename-input', function(ev) {
      const pageId = ev.currentTarget.dataset.pageid;
      const newName = ev.currentTarget.value;
      log('info', 'Renaming page input', { pageId, value: newName });
      $html.find(`.fr-tab[data-pageid="${pageId}"]`).text(newName);
      // Update state in memory so next render uses correct name
      let state = foundry.utils.duplicate(getState());
      let page = state.pages.find(p => p.id === pageId);
      if (page) page.name = newName;
      window._fr_temp_state = state;
    });

    $html.on('blur change', '.fr-rename-input', async (ev) => {
      const pageId = ev.currentTarget.dataset.pageid;
      const newName = ev.currentTarget.value.trim();
      log('info', 'Rename page blur/change', { pageId, value: newName });
      // Use temp state if available (from input event), else duplicate
      let state = window._fr_temp_state || foundry.utils.duplicate(getState());
      let page = state.pages.find(p => p.id === pageId);
      if (page && newName) {
        page.name = newName;
        if (state.pendingRenamePageId === pageId) {
          delete state.pendingRenamePageId;
          window._fr_temp_state && delete window._fr_temp_state.pendingRenamePageId;
        }
        await saveState(state);
        // Fetch latest state from settings and use for next render
        const latestState = getState();
        window._fr_temp_state = latestState;
        // Hide input and show button immediately
        $html.find(`.fr-rename-input[data-pageid="${pageId}"]`).hide();
        $html.find(`.fr-rename-page[data-pageid="${pageId}"]`).show();
        this.render(true);
      } else {
        $html.find(`.fr-rename-input[data-pageid="${pageId}"]`).hide();
        $html.find(`.fr-rename-page[data-pageid="${pageId}"]`).show();
      }
    });
    // Delete page (cannot delete last page)
    $html.find('#fr-del-page').on('click', async () => {
      log('info', 'Delete page clicked');
      const state = getState();
      if (state.pages.length <= 1) return ui.notifications?.warn("Cannot delete the last page.");
      const idx = state.pages.findIndex(p => p.id === state.activePageId);
      if (idx >= 0) {
        state.pages.splice(idx, 1);
        // Set active to previous or first
        state.activePageId = state.pages[Math.max(0, idx - 1)]?.id || state.pages[0].id;
        await saveState(state);
        // Fetch latest state from settings and use for next render
        const latestState = getState();
        window._fr_temp_state = latestState;
        this.render(true);
      }
    });

    const addItem = async () => {
      const nameInput = $html.find('#fr-new-name')[0];
      const name = nameInput?.value?.trim();
      log('info', 'Add faction clicked', { name });
  if (!name) return ui.notifications?.warn('Enter an item name.');
      // Always fetch latest state from settings
      const state = getState();
      const page = state.pages.find(p => p.id === state.activePageId);
      if (page) {
  // Default persistOnZero to false (GM can enable per item)
  page.factions.push({ id: foundry.utils.randomID(), name, img: 'icons/svg/shield.svg', persistOnZero: false, playerControlled: false, imgConfig: defaultImageConfig() });
        await saveState(state);
        // Fetch latest state and use for next render
        const latestState = getState();
        window._fr_temp_state = latestState;
        this.render(true);
      }
    };
    $html.find('#fr-add').on('click', addItem);
    $html.find('#fr-new-name').on('keydown', (ev) => {
      if (ev.key === 'Enter') {
        log('info', 'Add faction keydown', ev.key);
        ev.preventDefault();
        addItem();
      }
    });

    // Delete faction from active page
    $html.find('.fr-del').on('click', async (ev) => {
      const fid = ev.currentTarget.dataset.fid;
      log('info', 'Delete faction clicked', { factionId: fid });
      if (!fid) return;
      // Always fetch latest state from settings
      const state = getState();
      const page = state.pages.find(p => p.id === state.activePageId);
      if (page) {
        page.factions = page.factions.filter(f => f.id !== fid);
        for (const uid of Object.keys(page.userRelations ?? {})) {
          if (page.userRelations[uid]) delete page.userRelations[uid][fid];
        }
        if (Array.isArray(page.announcements)) {
          page.announcements = page.announcements.filter(a => a.factionId !== fid);
        }
        await saveState(state);
        // Fetch latest state and use for next render
        const latestState = getState();
        window._fr_temp_state = latestState;
        this.render(true);
      }
    });

    // Toggle image background enable/disable (GM and Player allowed)
    $html.find('.fr-img-bg-toggle').on('change', async (ev) => {
      const fid = ev.currentTarget.dataset.fid;
      const enabled = ev.currentTarget.checked;
      const globalState = getState();
      const localActivePageId = window._fr_temp_state?.activePageId || globalState.activePageId;
      const page = globalState.pages.find(p => p.id === localActivePageId);
      if (!page) return;
      const faction = page.factions.find(f => f.id === fid);
      if (!faction) return;
      // Optimistic local update
      faction.imgBgEnabled = enabled;
      // Preserve player's active page if different from GM's
      window._fr_temp_state = { ...globalState, activePageId: localActivePageId };
      this.render(true);
      if (game.user.isGM) {
        await saveState(globalState);
      } else if (game.bagOfListsSocket) {
        game.bagOfListsSocket.executeAsGM('updateFactionBackground', {
          pageId: localActivePageId,
          factionId: fid,
          imgBgEnabled: enabled
        });
      }
    });

    // Selecting a background option
    $html.find('.fr-bg-option').on('click', async (ev) => {
      const fid = ev.currentTarget.dataset.fid;
      const bgClass = ev.currentTarget.dataset.bgclass || '';
      const globalState = getState();
      const localActivePageId = window._fr_temp_state?.activePageId || globalState.activePageId;
      const page = globalState.pages.find(p => p.id === localActivePageId);
      if (!page) return;
      const faction = page.factions.find(f => f.id === fid);
      if (!faction) return;
      faction.imgBgClass = bgClass;
      if (bgClass && !faction.imgBgEnabled) faction.imgBgEnabled = true;
      window._fr_temp_state = { ...globalState, activePageId: localActivePageId }; // optimistic
      // Close dropdown
      const dd = ev.currentTarget.closest('.fr-bg-dropdown');
      if (dd) dd.classList.remove('open');
      this.render(true);
      if (game.user.isGM) {
        await saveState(globalState);
      } else if (game.bagOfListsSocket) {
        game.bagOfListsSocket.executeAsGM('updateFactionBackground', {
          pageId: localActivePageId,
          factionId: fid,
          imgBgClass: bgClass,
          imgBgEnabled: faction.imgBgEnabled
        });
      }
    });

    // Dropdown click toggler (prevent hover-open) - attach once per render
    $html.find('.fr-bg-selector').off('click').on('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const button = ev.currentTarget;
      // Close any open dropdowns first
      $('.fr-bg-dropdown.open').each((_, el) => {
        $(el).find('.fr-bg-dropdown-content').css('display', '');
      });
      $('.fr-bg-dropdown.open').removeClass('open');
      $('.fr-bg-dropdown-portal').remove();
      // Open the dropdown
      const dropdown = $(button).siblings('.fr-bg-dropdown-content').first();
      if (!dropdown.length) return;
      // Portal the dropdown to the closest .fr-table-container
      let tableContainer = button.closest('.fr-table-container');
      if (!tableContainer) tableContainer = document.body;
      // Clone the dropdown for portaling
      const portalDropdown = dropdown.clone(true, true).addClass('fr-bg-dropdown-portal');
      // Remove any existing portal dropdowns
      $(tableContainer).find('.fr-bg-dropdown-portal').remove();
      const restoreOriginal = () => {
        dropdown.css('display', '');
      };
      dropdown.css('display', 'none');
      // Calculate position
      const containerRect = tableContainer.getBoundingClientRect();
      const btnRect = button.getBoundingClientRect();
      const top = btnRect.top - containerRect.top + tableContainer.scrollTop + button.offsetHeight;
      const left = btnRect.left - containerRect.left + tableContainer.scrollLeft;
      portalDropdown.css({
        position: 'absolute',
        top: top + 'px',
        left: left + 'px',
        zIndex: 20000,
        minWidth: dropdown.outerWidth() + 'px',
        display: 'block'
      });
      $(tableContainer).append(portalDropdown);
      // Mark as open for styling
      $(button).closest('.fr-bg-dropdown').addClass('open');
      // Close on click outside
      $(document).one('mousedown.fr-bg-dropdown', function (evt) {
        if (!portalDropdown[0].contains(evt.target) && !button.contains(evt.target)) {
          restoreOriginal();
          portalDropdown.remove();
          $(button).closest('.fr-bg-dropdown').removeClass('open');
        }
      });
      // Handle option click
      portalDropdown.find('.fr-bg-option').on('click', function () {
        restoreOriginal();
        portalDropdown.remove();
        $(button).closest('.fr-bg-dropdown').removeClass('open');
      });
    });
    // Global outside click to close
    $(document).off('click.bol-bg').on('click.bol-bg', (ev) => {
      if (!ev.target.closest('.fr-bg-dropdown')) {
        $html.find('.fr-bg-dropdown.open').each((_, el) => {
          el.classList.remove('open');
          $(el).find('.fr-bg-dropdown-content').css('display', '');
          const card = el.closest('.fr-card');
          if (card) card.classList.remove('fr-dropdown-active');
        });
        $('.fr-bg-dropdown-portal').remove();
      }
    });

    // Change faction image in active page
    $html.find('.fr-img').on('click', (ev) => {
      const fid = ev.currentTarget.dataset.fid;
      log('info', 'Faction image picker opened', { factionId: fid });
      const fp = new FilePicker({
        type: 'image',
        callback: async (path) => {
          log('info', 'Faction image selected', { factionId: fid, path });
          const state = getState();
          const page = state.pages.find(p => p.id === state.activePageId);
          const f = page?.factions.find(x => x.id === fid);
          if (f) {
            f.img = path;
            f.imgConfig = defaultImageConfig();
            await saveState(state);
            this.render(true);
          }
        }
      });
      fp.render(true);
    });

    $html.find('.fr-img-edit').on('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const fid = ev.currentTarget.dataset.fid;
      const pageId = ev.currentTarget.dataset.pageid || window._fr_temp_state?.activePageId || getState().activePageId;
      if (!fid) return;
      const state = window._fr_temp_state || getState();
      const page = state.pages?.find?.(p => p.id === pageId) || state.pages?.find?.(p => p.id === state.activePageId);
      const faction = page?.factions?.find?.(f => f.id === fid);
      if (!page || !faction) return;
      const imgConfig = normalizeImageConfig(faction.imgConfig);
      const imgSrc = faction.img || 'icons/svg/shield.svg';
      const editor = new PortraitEditorApp({
        pageId: page.id,
        factionId: fid,
        imgSrc,
        imgConfig,
        parentApp: this
      });
      editor.render(true);
    });

    // Value changes (-50..+50) for active page
    $html.find('.fr-val').on('change blur', async (ev) => {
      const input = ev.currentTarget;
      const fid = input.dataset.fid;
      const uid = input.dataset.uid;
      let v = Number(input.value) || 0;
      v = Math.max(-50, Math.min(50, Math.round(v)));
      log('info', 'Faction value changed', { factionId: fid, userId: uid, value: v });
      // Always fetch latest state from settings
      const state = getState();
      const page = state.pages.find(p => p.id === state.activePageId);
      if (page) {
        page.userRelations ||= {};
        page.userRelations[uid] ||= {};
        page.userRelations[uid][fid] = v;
        resetAnnouncementDismissalsForPage(page);
        await saveState(state);
        // Fetch latest state and use for next render
        const latestState = getState();
        window._fr_temp_state = latestState;
        if (game.user.isGM && game.socket) {
          console.log('[FactionTracker] socket emit (numeric change)', latestState);
          game.socket.emit('module.bag-of-lists', latestState, {broadcast: true});
        }
        this.render(true);
      }
    });

    // Initialize drag and drop functionality
    this._initializeDragAndDrop($html);

    $html.find('.fr-custom-subtab').on('click', (ev) => {
      const customId = ev.currentTarget.dataset.customid;
      const pageId = ev.currentTarget.dataset.pageid;
      if (!customId || !pageId) return;
      if (!window._fr_custom_activePageMap || typeof window._fr_custom_activePageMap !== 'object') {
        window._fr_custom_activePageMap = {};
      }
      if (window._fr_custom_activePageMap[customId] === pageId) return;
      window._fr_custom_activePageMap[customId] = pageId;
      this.render(true);
    });

    applyImageTransforms(this.element);
  }

  async _commitPendingFactionValues($html) {
    if (!game.user.isGM) return;
    if (!$html) return;
    const state = getState();
    const page = state.pages.find(p => p.id === state.activePageId);
    if (!page) return;
    let dirty = false;
    const inputs = $html.find('.fr-val');
    inputs.each((_, element) => {
      const input = element;
      const fid = input.dataset.fid;
      const uid = input.dataset.uid;
      if (!fid || !uid) return;
      const domNumber = Number(input.value);
      if (!Number.isFinite(domNumber)) return;
      const sanitized = Math.max(-50, Math.min(50, Math.round(domNumber)));
      if (String(sanitized) !== input.value) {
        input.value = String(sanitized);
      }
      page.userRelations ||= {};
      page.userRelations[uid] ||= {};
      const existingRaw = page.userRelations[uid][fid];
      const existing = Number(existingRaw);
      if (!Number.isFinite(existing) || existing !== sanitized) {
        page.userRelations[uid][fid] = sanitized;
        dirty = true;
      }
    });
    if (dirty) {
      resetAnnouncementDismissalsForPage(page);
      await saveState(state);
      const latest = getState();
      window._fr_temp_state = latest;
    }
  }

  /** 
   * Initialize drag and drop functionality for both table rows and cards
   */
  _initializeDragAndDrop($html) {
    // Only allow drag and drop for GM (tables) and players with player-controlled factions (cards)
    const isGM = !!game.user.isGM;
    // Reordering should be GM-only per new requirement
    if (!isGM) return; // Disable entirely for players
    
    // Get draggable elements based on view
  const draggableSelector = '.fr-drag-handle';
    const $draggables = $html.find(draggableSelector);

    if ($draggables.length === 0) {
      return; // No draggable elements found
    }

    console.log(`[FactionTracker] Drag and drop initialized: ${$draggables.length} draggable elements`);

    // Clean up any existing drag event handlers to prevent accumulation
    $draggables.off('mousedown.drag-reorder');
    
    let draggedElement = null;
    let draggedIndex = null;
    let draggedData = null;
    let ghostElement = null;
    let placeholder = null;
    let dropZone = null;

    // Helper function to create ghost element
    const createGhostElement = (originalElement) => {
      if (isGM) {
        // For GM view, create a simplified version of the table row
        const tableRow = originalElement.closest('tr');
        const factionName = tableRow.querySelector('.fr-name')?.textContent || 'Faction';
        const factionImg = tableRow.querySelector('.fr-img')?.src || 'icons/svg/shield.svg';
        
        // Create a simplified ghost that looks like a faction item
        const ghost = document.createElement('div');
        ghost.classList.add('fr-drag-ghost', 'fr-ghost-table-row');
        ghost.innerHTML = `
          <div style="display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: #23232b; border: 2px solid #b48e5a; border-radius: 6px; min-width: 200px;">
            <img src="${factionImg}" style="width: 24px; height: 24px; border-radius: 4px; object-fit: cover;" />
            <span style="color: #fff; font-weight: 600;">${factionName}</span>
          </div>
        `;
        
        document.body.appendChild(ghost);
        return ghost;
      } else {
        // For player view, clone the card but make it smaller
        const ghost = originalElement.cloneNode(true);
        ghost.classList.add('fr-drag-ghost', 'fr-ghost-card');
        ghost.style.transform = 'scale(0.9)';
        ghost.style.maxWidth = '200px';
        
        document.body.appendChild(ghost);
        return ghost;
      }
    };

    // Helper function to create placeholder
    const createPlaceholder = () => {
      const placeholder = document.createElement('div');
      placeholder.classList.add('fr-drop-placeholder');
      
      if (isGM) {
        placeholder.classList.add('fr-placeholder-table-row');
        placeholder.innerHTML = '<div style="text-align: center;">Drop here</div>';
        // For table, we need to create a full table row
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 999; // Span all columns
        td.appendChild(placeholder);
        tr.appendChild(td);
        return tr;
      } else {
        placeholder.classList.add('fr-placeholder-card');
        placeholder.innerHTML = '<div>Drop here</div>';
        return placeholder;
      }
    };

    // Helper function to get faction data from element
    const getFactionDataFromElement = (element) => {
      if (isGM) {
        // For drag handles, get the table row and find faction ID from any input in the row
        const tableRow = element.closest('tr');
        const factionInput = tableRow ? tableRow.querySelector('[data-fid]') : null;
        return factionInput ? factionInput.dataset.fid : null;
      } else {
        // For cards, get faction ID from arrow buttons or other elements
        const factionElement = element.querySelector('[data-fid]');
        return factionElement ? factionElement.dataset.fid : null;
      }
    };

    // Helper function to get drop index from mouse position
    const getDropIndex = (clientY) => {
      if (!dropZone) return 0;
      
      const container = dropZone;
      // Get all visible elements (excluding placeholder and hidden dragged element)
      const elements = Array.from(container.children).filter(el => 
        !el.classList.contains('fr-drop-placeholder') && 
        !el.classList.contains('fr-drag-hidden') &&
        el.style.display !== 'none'
      );

      // If no elements, return 0
      if (elements.length === 0) return 0;

      for (let i = 0; i < elements.length; i++) {
        const rect = elements[i].getBoundingClientRect();
        const midpoint = rect.top + rect.height / 2;
        
        // If mouse is above the midpoint of this element, insert before it
        if (clientY < midpoint) {
          return i;
        }
      }
      
      // If we're past all elements, insert at the end
      return elements.length;
    };

    // Helper function to update placeholder position
    let currentPlaceholderIndex = -1;
    const updatePlaceholderPosition = (clientY) => {
      if (!placeholder || !dropZone || !this._isDragging) return;

      try {
        const newIndex = getDropIndex(clientY);
        
        // Only update if index actually changed
        if (newIndex === currentPlaceholderIndex) return;
        
        const container = dropZone;
        
        // Check if container still exists and is valid
        if (!container || !container.parentNode) return;
        
        // Get all visible elements (excluding placeholder and hidden dragged element)
        const elements = Array.from(container.children).filter(el => 
          !el.classList.contains('fr-drop-placeholder') &&
          !el.classList.contains('fr-drag-hidden') &&
          el.style.display !== 'none'
        );
        
        // Remove existing placeholder safely
        if (placeholder.parentNode === container) {
          container.removeChild(placeholder);
        }

        // Insert placeholder at new position
        if (newIndex >= elements.length) {
          // Insert at the end
          container.appendChild(placeholder);
        } else {
          // Insert before the element at newIndex
          const targetElement = elements[newIndex];
          if (targetElement && targetElement.parentNode === container) {
            container.insertBefore(placeholder, targetElement);
          } else {
            // Fallback: append at end if target element is invalid
            container.appendChild(placeholder);
          }
        }
        
        currentPlaceholderIndex = newIndex;
        
      } catch (error) {
        console.warn('[FactionTracker] Error updating placeholder position:', error);
      }
    };

    // Mouse move handler with throttling
    let lastMoveTime = 0;
    const handleMouseMove = (e) => {
      if (!ghostElement || !draggedElement || !this._isDragging) return;
      
      // Throttle mouse move events to improve performance
      const now = Date.now();
      if (now - lastMoveTime < 16) return; // ~60fps
      lastMoveTime = now;
      
      // Update ghost position
      ghostElement.style.left = e.clientX - 100 + 'px';
      ghostElement.style.top = e.clientY - 30 + 'px';
      
      // Update placeholder position
      updatePlaceholderPosition(e.clientY);
    };

    // Mouse up handler  
    const handleMouseUp = (e) => {
      if (!draggedElement || !placeholder || !this._isDragging) return;
      
      // Calculate final drop index
      const finalIndex = getDropIndex(e.clientY);
      
      // Clean up UI elements
      if (ghostElement && ghostElement.parentNode) {
        ghostElement.parentNode.removeChild(ghostElement);
        ghostElement = null;
      }
      
      if (placeholder && placeholder.parentNode) {
        placeholder.parentNode.removeChild(placeholder);
        placeholder = null;
      }
      
      if (dropZone) {
        dropZone.classList.remove('fr-drop-zone');
        dropZone = null;
      }
      
      // Restore text selection
      document.body.style.userSelect = '';
      
      // Remove global event listeners
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      
      // Reset dragging flag and placeholder index
      this._isDragging = false;
      currentPlaceholderIndex = -1;
      
      // Only proceed with reordering if position changed
      if (finalIndex !== draggedIndex && draggedData) {
        // Trigger reorder function (element will be shown after re-render)
        this._reorderFactions(draggedData, draggedIndex, finalIndex);
      } else {
        // No reorder needed, show original element immediately
        if (draggedElement) {
          draggedElement.classList.remove('fr-drag-hidden');
        }
      }
      
      // Reset drag state
      draggedElement = null;
      draggedIndex = null;
      draggedData = null;
    };

    // Add drag event listeners to each draggable element using namespaced events for clean removal
    $draggables.on('mousedown.drag-reorder', (e) => {
      const element = e.currentTarget;
      
      // For GM view, prevent dragging if not clicking on drag handle
      if (isGM && !e.target.closest('.fr-drag-handle')) {
        return;
      }
      
      // For player view, prevent dragging if clicking on interactive elements
      if (!isGM && e.target.matches('input, button, .fr-del, .fr-img, .fr-checkbox')) {
        return;
      }

      // Prevent multiple drags
      if (this._isDragging) return;

        e.preventDefault();
        
        this._isDragging = true;
        
        // For GM view, get the table row; for player view, use the card directly
        draggedElement = isGM ? element.closest('tr') : element;
        draggedIndex = Array.from(draggedElement.parentNode.children).indexOf(draggedElement);
        draggedData = getFactionDataFromElement(element);
        
        // Validate we have required data
        if (!draggedData) {
          this._isDragging = false;
          return;
        }
        
        ghostElement = createGhostElement(element);
        
        placeholder = createPlaceholder();
        
        dropZone = isGM ? $html.find('.fr-table tbody')[0] : $html.find('.fr-grid')[0];
        if (dropZone) {
          dropZone.classList.add('fr-drop-zone');
        }
        
        // Hide original element (use draggedElement, not element)
        draggedElement.classList.add('fr-drag-hidden');
        
        // Position ghost at cursor
        const rect = element.getBoundingClientRect();
        ghostElement.style.left = e.clientX - rect.width / 2 + 'px';
        ghostElement.style.top = e.clientY - rect.height / 2 + 'px';
        
        // Insert initial placeholder using current mouse position
        currentPlaceholderIndex = -1;
        updatePlaceholderPosition(e.clientY);
        
        // Add global mouse event listeners
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        
        // Prevent text selection
        document.body.style.userSelect = 'none';
    });
  }

  /**
   * Reorder factions in the data and persist changes
   */
  async _reorderFactions(factionId, oldIndex, newIndex) {
    // Only allow GM to reorder factions
    if (!game.user.isGM) {
      console.warn('[FactionTracker] Only GM can reorder factions');
      return;
    }
    
    try {
      const state = getState();
      const page = state.pages.find(p => p.id === state.activePageId);
      
      if (!page || !page.factions) {
        console.warn('[FactionTracker] No active page or factions found for reordering');
        return;
      }

      // Find the faction being moved
      const factionIndex = page.factions.findIndex(f => f.id === factionId);
      if (factionIndex === -1) {
        console.warn('[FactionTracker] Faction not found for reordering:', factionId);
        return;
      }

      // Remove faction from old position
      const [faction] = page.factions.splice(factionIndex, 1);
      
      // Insert at new position (adjust for removal)
      let insertIndex = newIndex;
      if (factionIndex < newIndex) {
        insertIndex = newIndex - 1;
      }
      
      page.factions.splice(insertIndex, 0, faction);
      
      // Save state and sync
      await saveState(state);
      
      // Update temp state and re-render (scroll position preserved by render override)
      const latestState = getState();
      window._fr_temp_state = latestState;
      this.render(true);
      
      log('info', 'Faction reordered successfully', { 
        factionId, 
        factionName: faction.name,
        oldIndex: factionIndex, 
        newIndex: insertIndex 
      });
      
    } catch (error) {
      logError('Failed to reorder factions', error);
      ui.notifications?.error('Failed to reorder factions. Please try again.');
    }
  }
}

/** ------- Make the app available and add Scene Controls tool ------- **/
Hooks.once("ready", () => {
  game.factionTracker = new FactionTrackerApp();
  // Register the openTracker function for use by the Scene Controls button
  game.factionRelations = {
    openTracker: () => {
      const app = game.factionTracker;
      if (app?.rendered) {
        app.close();
      } else {
        app.render(true);
        setTimeout(() => app.injectHeaderIcon(), 50);
      }
    }
  };
});

// Add a button under the Scene Controls (left toolbar) to open/close the app.
Hooks.on("getSceneControlButtons", (controls) => {
  try {
    let group = controls.tokens || controls.find?.(g => g.name === "tokens" || g.name === "token");
    if (group) {
      if (!group.tools || typeof group.tools !== "object") group.tools = {};
      group.tools["faction-tracker"] = {
        name: "faction-tracker",
        title: "Bag o' Lists",
  icon: "bol-toolbar-icon",
        button: true,
        visible: true,
        onChange: () => {
          game.factionRelations.openTracker();
        }
      };
    } else {
      console.warn("Faction Relations: Could not find tokens group to add tool");
    }
  } catch (err) {
    console.error(`${MODULE_ID} Scene Controls error:`, err);
  }
});

