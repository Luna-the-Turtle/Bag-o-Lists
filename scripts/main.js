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
  // Register the real update function for live sync
  socket.register('updateState', (newState) => {
    // Only update the shared data, preserve each user's active page
    const currentActivePageId = window._fr_temp_state?.activePageId;
    window._fr_temp_state = foundry.utils.duplicate(newState);
    
    // Restore user's active page if it exists and is valid
    if (currentActivePageId && newState.pages?.some(p => p.id === currentActivePageId)) {
      window._fr_temp_state.activePageId = currentActivePageId;
    }
    
    if (game.factionTracker?.rendered) {
      game.factionTracker.render(true);
    }
  });
  
  // Register handler for player value changes (GM only)
  socket.register('playerValueChange', async (data) => {
    if (!game.user.isGM) return; // Only GM can save
    
    const { factionId, userId, newValue } = data;
    const state = getState();
    const page = state.pages.find(p => p.id === state.activePageId);
    
    if (page) {
      page.userRelations ||= {};
      page.userRelations[userId] ||= {};
      page.userRelations[userId][factionId] = newValue;
      
      await saveState(state);
      
      // Broadcast the updated state to everyone (without activePageId)
      const latestState = getState();
      window.broadcastStateToPlayers(latestState);
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
          userRelations: {}
        }
      ],
      activePageId: null // will be set to first page on load
    }
  });
});

function getState() {
  // duplicate to avoid accidental in-place mutation of settings object
  const state = foundry.utils.duplicate(game.settings.get(MODULE_ID, "state"));
  // Remove legacy global arrays if present
  if (state.factions) delete state.factions;
  if (state.userRelations) delete state.userRelations;
  // If no activePageId, set to first page
  if (!state.activePageId && state.pages?.length) {
    state.activePageId = state.pages[0].id;
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
    const players = (game.users?.contents ?? game.users).filter(u => !u.isGM);

    // Find active page
    const activePage = state.pages.find(p => p.id === state.activePageId) || state.pages[0];
    // Defensive: if no page, create one
    if (!activePage) {
      const newPage = {
        id: foundry.utils.randomID(),
        name: "Factions",
        factions: [],
        userRelations: {}
      };
      state.pages.push(newPage);
      state.activePageId = newPage.id;
      await saveState(state);
      // refetch state after save
      return this._prepareContext(options);
    }

    // Only use per-page data
    const gmFactions = activePage.factions.map(f => {
      const cells = players.map(p => {
        const value = (activePage.userRelations?.[p.id]?.[f.id]) ?? 0;
        const clamped = Math.max(-50, Math.min(50, Number(value) || 0));
        const pct = Math.min(1, Math.max(0, Math.abs(clamped) / 50));
        
        return {
          userId: p.id,
          value: clamped,
          posWidth: (clamped > 0) ? Math.round(pct * 50) : 0,
          negWidth: (clamped < 0) ? Math.round(pct * 50) : 0
        };
      });
      return {
        id: f.id,
        name: f.name,
        img: f.img || "icons/svg/shield.svg",
        persistOnZero: f.persistOnZero ?? true,
        playerControlled: f.playerControlled ?? false,
        cells
      };
    });

    if (!isGM) {
      // Player-only view: show tabs for pages where player has a value
      const me = game.user;
      // Always use the latest state for all pages
      const playerPages = (state.pages || []).filter(page => {
  // Show page if at least one faction for this player has value ≠ 0
  // OR if any faction has persistOnZero true
  if (!page.userRelations?.[me.id]) return false;
  const factions = page.factions || [];
  const hasNonZero = Object.values(page.userRelations[me.id]).some(v => Number(v) !== 0);
  const hasPersist = factions.some(f => (f.persistOnZero ?? true));
  // Show page if any faction for this player is nonzero, or any faction is set to persistOnZero
  return hasNonZero || hasPersist;
      });
      // If no pages, show nothing
      if (playerPages.length === 0) {
        return { isGM, pages: [], activePageId: null, myFactions: [], pageName: null };
      }
      // Use activePageId if it's a valid player page, else first player page
      let activePageId = state.activePageId;
      if (!playerPages.some(p => p.id === activePageId)) {
        activePageId = playerPages[0].id;
      }
      const activePage = playerPages.find(p => p.id === activePageId) || playerPages[0];
      const myFactions = activePage.factions.map(f => {
        const val = (activePage.userRelations?.[me.id]?.[f.id]) ?? 0;
        const clamped = Math.max(-50, Math.min(50, Number(val) || 0));
        const pct = Math.min(1, Math.max(0, Math.abs(clamped) / 50));
        // Only show if value ≠ 0 or persistOnZero is true
        if (clamped !== 0 || (f.persistOnZero ?? true)) {
          return {
            id: f.id,
            name: f.name,
            img: f.img || "icons/svg/shield.svg",
            persistOnZero: f.persistOnZero ?? true,
            playerControlled: f.playerControlled ?? false,
            value: clamped,
            posWidth: (clamped > 0) ? Math.round(pct * 50) : 0,
            negWidth: (clamped < 0) ? Math.round(pct * 50) : 0
          };
        }
        return null;
      }).filter(f => f !== null);
      // Return only player-relevant pages and activePageId
      return {
        isGM,
        pages: playerPages,
        activePageId,
        myFactions,
        pageName: activePage.name
      };
    }

    // GM view includes players list, faction x player matrix, and all pages for tabs
    const gmPlayers = players.map(p => ({ id: p.id, name: p.name }));
    return {
      isGM,
      players: gmPlayers,
      factions: gmFactions,
      pages: state.pages,
      activePageId: state.activePageId,
      pageName: activePage.name
    };
  }

  _onRender(context, options) {
    const html = this.element;
    const $html = $(html);
    
    // Player: Up/down arrow handlers for playerControlled items
    $html.find('.fr-arrow-up').on('click', async (ev) => {
      const fid = ev.currentTarget.dataset.fid;
      const state = window._fr_temp_state || getState();
      const me = game.user;
      // Find active page and faction
      const page = (state.pages || []).find(p => p.id === state.activePageId);
      if (!page) return;
      const faction = page.factions.find(f => f.id === fid);
      if (!faction || !faction.playerControlled) return;
      page.userRelations ||= {};
      page.userRelations[me.id] ||= {};
      let v = Number(page.userRelations[me.id][fid]) || 0;
      v = Math.min(50, v + 1);
      page.userRelations[me.id][fid] = v;
      
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
            newValue: v
          });
        }
      }
      
      window._fr_temp_state = state;
      this.render(true);
    });

    $html.find('.fr-arrow-down').on('click', async (ev) => {
      const fid = ev.currentTarget.dataset.fid;
      const state = window._fr_temp_state || getState();
      const me = game.user;
      // Find active page and faction
      const page = (state.pages || []).find(p => p.id === state.activePageId);
      if (!page) return;
      const faction = page.factions.find(f => f.id === fid);
      if (!faction || !faction.playerControlled) return;
      page.userRelations ||= {};
      page.userRelations[me.id] ||= {};
      let v = Number(page.userRelations[me.id][fid]) || 0;
      v = Math.max(-50, v - 1);
      page.userRelations[me.id][fid] = v;
      
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
            newValue: v
          });
        }
      }
      
      window._fr_temp_state = state;
      this.render(true);
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
    $html.find('.fr-tab').off('click');
    $html.find('#fr-add-page').off('click');
    $html.find('.fr-rename-page').off('click');
    $html.off('input', '.fr-rename-input');
    $html.off('blur change', '.fr-rename-input');
    $html.find('#fr-del-page').off('click');
    $html.find('#fr-add').off('click');
    $html.find('#fr-new-name').off('keydown');
    $html.find('.fr-del').off('click');
    $html.find('.fr-img').off('click');
    $html.find('.fr-val').off('change blur');

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
      const pageId = ev.currentTarget.dataset.pageid;
      const isGM = !!game.user.isGM;
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
        // Player: update only local UI, ensure valid pages array
        const state = window._fr_temp_state || {};
        const me = game.user;
        // Filter pages for player
        const playerPages = (state.pages || getState().pages || []).filter(page => {
          if (!page.userRelations?.[me.id]) return false;
          return Object.values(page.userRelations[me.id]).some(v => Number(v) !== 0);
        });
        if (playerPages.length === 0) {
          window._fr_temp_state = { pages: [], activePageId: null };
          this.render(true);
          return;
        }
        window._fr_temp_state = {
          ...state,
          pages: playerPages,
          activePageId: pageId
        };
        this.render(true);
      }
    });

    $html.find('#fr-add-page').on('click', async () => {
      const state = getState();
      const newPage = {
        id: foundry.utils.randomID(),
        name: `Tracker ${state.pages.length + 1}`,
        factions: [],
        userRelations: {}
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
      if (!name) return ui.notifications?.warn('Enter a faction name.');
      // Always fetch latest state from settings
      const state = getState();
      const page = state.pages.find(p => p.id === state.activePageId);
      if (page) {
        // Default persistOnZero to true (can be changed by GM)
        page.factions.push({ id: foundry.utils.randomID(), name, img: 'icons/svg/shield.svg', persistOnZero: true, playerControlled: false });
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
        await saveState(state);
        // Fetch latest state and use for next render
        const latestState = getState();
        window._fr_temp_state = latestState;
        this.render(true);
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
            await saveState(state);
            this.render(true);
          }
        }
      });
      fp.render(true);
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
  }

  /** 
   * Initialize drag and drop functionality for both table rows and cards
   */
  _initializeDragAndDrop($html) {
    // Only allow drag and drop for GM (tables) and players with player-controlled factions (cards)
    const isGM = !!game.user.isGM;
    
    // Get draggable elements based on view
    const draggableSelector = isGM ? '.fr-drag-handle' : '.fr-card';
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

