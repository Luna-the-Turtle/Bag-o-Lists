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

// --- Announcement Chat Message Utility ---

/**
 * Check and send chat messages for announcements that have triggered
 * Chat messages are sent EVERY time the condition is met when a value changes.
 * This is completely separate from UI dismissals.
 * Only processes announcements for the specific faction that was changed.
 * @param {Object} page - The page object containing factions and announcements
 * @param {string} userId - The user ID whose values triggered the announcement
 * @param {string} factionId - The faction ID that was just changed
 */
function checkAndSendAnnouncementChatMessages(page, userId, factionId) {
  if (!page?.announcements?.length) return;
  if (!game.user.isGM) return; // Only GM sends chat messages
  if (!factionId) return; // Must specify which faction changed
  
  for (const announcement of page.announcements) {
    if (!announcement.sendToChat) continue;
    
    // Only process announcements for the faction that was just changed
    if (announcement.factionId !== factionId) continue;
    
    const targets = Array.isArray(announcement.targets) && announcement.targets.length ? announcement.targets : ['gm'];
    const isAnyPlayer = targets.includes('any-player');
    const isAllPlayers = targets.includes('all-players');
    const isDirectlyTargeted = targets.includes(userId);
    
    // Skip if this announcement doesn't apply to this user
    if (!isDirectlyTargeted && !isAnyPlayer && !isAllPlayers) continue;
    
    // Check if the condition is met
    const operatorKey = announcement.operator === 'ge' ? 'ge' : 'le';
    const thresholdNumeric = Number(announcement.threshold);
    if (!Number.isFinite(thresholdNumeric)) continue;
    
    const faction = page.factions.find(f => f.id === announcement.factionId);
    if (!faction) continue;
    
    const rawValue = page.userRelations?.[userId]?.[announcement.factionId];
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    
    const passes = operatorKey === 'ge' ? value >= thresholdNumeric : value <= thresholdNumeric;
    if (!passes) continue;
    
    // Condition is met - ALWAYS send the chat message (no tracking/deduplication)
    
    // Build the chat message based on settings
    const operatorSymbol = operatorKey === 'ge' ? '≥' : '≤';
    const userName = game.users.get(userId)?.name ?? 'Unknown';
    const includeDetails = announcement.chatIncludeDetails !== false;
    
    let chatContent;
    if (includeDetails) {
      chatContent = `<div class="bol-announcement-chat">
        <strong>📢 Announcement Triggered</strong><br>
        <em>${faction.name}</em> ${operatorSymbol} ${thresholdNumeric}<br>
        <strong>Message:</strong> ${announcement.message ?? 'No message'}<br>
        <small>Triggered by: ${userName} (current value: ${value})</small>
      </div>`;
    } else {
      // Simple message only
      chatContent = `<div class="bol-announcement-chat">
        <strong>📢</strong> ${announcement.message ?? 'Announcement triggered'}
      </div>`;
    }
    
    // Determine chat recipients
    const chatRecipients = Array.isArray(announcement.chatRecipients) && announcement.chatRecipients.length 
      ? announcement.chatRecipients 
      : ['gm'];
    
    let whisperIds = [];
    if (chatRecipients.includes('all')) {
      // Public message - no whisper
      whisperIds = null;
    } else {
      // Build whisper list
      for (const recipientId of chatRecipients) {
        if (recipientId === 'gm') {
          whisperIds.push(...game.users.filter(u => u.isGM).map(u => u.id));
        } else if (recipientId === 'any-player') {
          // Send to the user who triggered it
          whisperIds.push(userId);
        } else {
          const user = game.users.get(recipientId);
          if (user) whisperIds.push(user.id);
        }
      }
      // Deduplicate
      whisperIds = [...new Set(whisperIds)];
    }
    
    const messageData = {
      content: chatContent,
      speaker: { alias: 'Bag o\' Lists' }
    };
    if (whisperIds !== null && whisperIds.length > 0) {
      messageData.whisper = whisperIds;
    }
    
    ChatMessage.create(messageData);
    log('info', `Announcement chat sent: ${faction.name} for user ${userName} (value: ${value})`);
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
    
    // Preserve local permanent dismissals before overwriting state
    // But skip any that were recently re-enabled by the player
    const localDismissals = {};
    if (window._fr_temp_state?.pages && !game.user.isGM) {
      const currentUserId = game.user.id;
      for (const page of window._fr_temp_state.pages) {
        if (page.announcements) {
          for (const ann of page.announcements) {
            if (ann.dismissedBy?.[currentUserId] === 'permanent') {
              const key = `${page.id}-${ann.id}`;
              // Skip if recently re-enabled
              if (window._fr_recently_reenabled?.has(key)) {
                continue;
              }
              localDismissals[key] = true;
            }
          }
        }
      }
    }
    
    window._fr_temp_state = foundry.utils.duplicate(newState);
    
    // Restore local permanent dismissals to the new state
    if (Object.keys(localDismissals).length > 0 && window._fr_temp_state?.pages) {
      const currentUserId = game.user.id;
      for (const page of window._fr_temp_state.pages) {
        if (page.announcements) {
          for (const ann of page.announcements) {
            const key = `${page.id}-${ann.id}`;
            if (localDismissals[key]) {
              ann.dismissedBy ||= {};
              ann.dismissedBy[currentUserId] = 'permanent';
            }
          }
        }
      }
    }
    
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
      
      // Check and send chat messages for triggered announcements (only for this faction)
      checkAndSendAnnouncementChatMessages(page, userId, factionId);

      await saveState(state);

      // Broadcast the updated state to everyone (without activePageId)
      const latestState = getState();
      window.broadcastStateToPlayers(latestState);
    }
  });

  socket.register('playerDismissAnnouncement', async (data) => {
    if (!game.user.isGM) return;
    const { pageId, announcementId, userId, permanent } = data || {};
    if (!pageId || !announcementId || !userId || userId === 'gm') return;

    const state = getState();
    const page = state.pages.find(p => p.id === pageId);
    if (!page?.announcements) return;
    const announcement = page.announcements.find(a => a.id === announcementId);
    if (!announcement) return;
    
    // Check if user is targeted (including all-players and any-player)
    const isTargeted = Array.isArray(announcement.targets) && (
      announcement.targets.includes(userId) ||
      announcement.targets.includes('all-players') ||
      announcement.targets.includes('any-player')
    );
    if (!isTargeted) return;

    announcement.dismissedBy ||= {};
    announcement.dismissedBy[userId] = permanent ? 'permanent' : true;
    console.log(`[bag-of-lists] GM saved dismissal for user ${userId} on announcement ${announcementId}, permanent: ${permanent}`);
    if (!permanent) {
      resetAnnouncementDismissalsForPage(page);
    }

    await saveState(state);

    const latestState = getState();
    window.broadcastStateToPlayers(latestState);
  });
  
  socket.register('playerReenableAnnouncement', async (data) => {
    if (!game.user.isGM) return;
    const { pageId, announcementId, userId } = data || {};
    if (!pageId || !announcementId || !userId || userId === 'gm') return;

    const state = getState();
    const page = state.pages.find(p => p.id === pageId);
    if (!page?.announcements) return;
    const announcement = page.announcements.find(a => a.id === announcementId);
    if (!announcement) return;
    
    // Check if user is targeted (including all-players and any-player)
    const isTargeted = Array.isArray(announcement.targets) && (
      announcement.targets.includes(userId) ||
      announcement.targets.includes('all-players') ||
      announcement.targets.includes('any-player')
    );
    if (!isTargeted) return;

    if (announcement.dismissedBy?.[userId]) {
      delete announcement.dismissedBy[userId];
      console.log(`[bag-of-lists] GM removed dismissal for user ${userId} on announcement ${announcementId}`);
    }

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
  // Track whether the dismissals dropdown is collapsed (default: collapsed/true)
  if (typeof window._fr_dismissals_collapsed === 'undefined') {
    window._fr_dismissals_collapsed = true;
  }
  // Track recently re-enabled announcements to prevent merge from re-adding them
  if (!window._fr_recently_reenabled) {
    window._fr_recently_reenabled = new Set();
  }
  
  // DO NOT initialize temp state here - settings aren't registered yet!
  // This will be done in the ready hook after init completes
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
  
  // Archive storage for saved entries
  game.settings.register(MODULE_ID, "archive", {
    scope: "world",
    config: false,
    type: Object,
    default: {
      entries: [] // Archived custom entries
    }
  });
  
  // ===== User-Configurable Settings =====
  
  // Confirmation & Warning Settings
  game.settings.register(MODULE_ID, "confirmDeletePage", {
    name: "Confirm Page Deletion",
    hint: "Show a warning dialog before deleting a page/bag and all its contents.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });
  
  game.settings.register(MODULE_ID, "confirmDeleteItem", {
    name: "Confirm Item Deletion",
    hint: "Show a warning dialog before deleting individual items from a list.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });
  
  // Default Values for New Items
  game.settings.register(MODULE_ID, "defaultMinValue", {
    name: "Default Minimum Value",
    hint: "The default minimum value for newly created list items.",
    scope: "world",
    config: true,
    type: Number,
    default: -50
  });
  
  game.settings.register(MODULE_ID, "defaultMaxValue", {
    name: "Default Maximum Value",
    hint: "The default maximum value for newly created list items.",
    scope: "world",
    config: true,
    type: Number,
    default: 50
  });
  
  game.settings.register(MODULE_ID, "defaultItemImage", {
    name: "Default Item Image",
    hint: "The default image path for newly created list items. Leave empty for default shield icon.",
    scope: "world",
    config: true,
    type: String,
    default: "icons/svg/shield.svg",
    filePicker: 'image'
  });
  
  // Display Settings
  game.settings.register(MODULE_ID, "compactMode", {
    name: "Compact Display Mode",
    hint: "Use a more compact layout to fit more items on screen. Reduces spacing and font sizes. Note: Conflicts with Large Fonts when both enabled.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => game.factionTracker?.render(true)
  });
  
  game.settings.register(MODULE_ID, "showTooltips", {
    name: "Show Tooltips",
    hint: "Display helpful tooltips when hovering over buttons and controls in the Bag o' Lists window.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => game.factionTracker?.render(true)
  });
  
  game.settings.register(MODULE_ID, "showPlayerNames", {
    name: "Show Player Names in GM View",
    hint: "Display player/character names above their columns in the GM view.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => game.factionTracker?.render(true)
  });
  
  // Accessibility Settings
  game.settings.register(MODULE_ID, "largeFonts", {
    name: "Large Fonts",
    hint: "Increase font sizes throughout the Bag o' Lists module for better readability. Note: Conflicts with Compact Mode when both enabled.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => game.factionTracker?.render(true)
  });
  
  game.settings.register(MODULE_ID, "highContrast", {
    name: "High Contrast Mode",
    hint: "Use higher contrast colors for better visibility and accessibility in Bag o' Lists.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => game.factionTracker?.render(true)
  });
  
  // Archive Settings
  game.settings.register(MODULE_ID, "showArchiveReminder", {
    name: "Show Archive Reminder",
    hint: "Show a notification when deleting items, reminding you that you can archive them instead.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });
  
  // Import/Export Settings
  game.settings.register(MODULE_ID, "confirmImport", {
    name: "Confirm Before Import",
    hint: "Show a warning before importing archive data, as it will replace current entries.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });
});

// Archive utility functions
function getArchive() {
  const archive = foundry.utils.duplicate(game.settings.get(MODULE_ID, "archive"));
  if (!Array.isArray(archive.entries)) {
    archive.entries = [];
  }
  return archive;
}

async function saveArchive(archive) {
  await game.settings.set(MODULE_ID, "archive", archive);
}

async function archiveEntry(entryId) {
  const state = getState();
  const entryIndex = state.customEntries?.findIndex(e => e.id === entryId);
  if (entryIndex === -1 || entryIndex === undefined) {
    ui.notifications?.warn('Entry not found.');
    return false;
  }
  
  const entry = state.customEntries[entryIndex];
  const archive = getArchive();
  
  // Add timestamp for when it was archived
  entry.archivedAt = Date.now();
  archive.entries.push(entry);
  
  // Remove from active entries
  state.customEntries.splice(entryIndex, 1);
  
  await saveState(state);
  await saveArchive(archive);
  return true;
}

async function restoreEntry(entryId) {
  const archive = getArchive();
  const entryIndex = archive.entries?.findIndex(e => e.id === entryId);
  if (entryIndex === -1 || entryIndex === undefined) {
    ui.notifications?.warn('Archived entry not found.');
    return false;
  }
  
  const entry = archive.entries[entryIndex];
  const state = getState();
  
  // Remove archive timestamp
  delete entry.archivedAt;
  
  state.customEntries ||= [];
  state.customEntries.push(entry);
  
  // Remove from archive
  archive.entries.splice(entryIndex, 1);
  
  await saveState(state);
  await saveArchive(archive);
  return true;
}

async function deleteArchivedEntry(entryId) {
  const archive = getArchive();
  const entryIndex = archive.entries?.findIndex(e => e.id === entryId);
  if (entryIndex === -1 || entryIndex === undefined) {
    ui.notifications?.warn('Archived entry not found.');
    return false;
  }
  
  archive.entries.splice(entryIndex, 1);
  await saveArchive(archive);
  return true;
}

function exportArchive() {
  // Export BOTH archived entries AND active custom entries
  // This captures the complete state at export time
  const archive = getArchive();
  const state = getState();
  
  const exportData = {
    version: 2, // Version flag to distinguish from old format
    entries: archive.entries || [], // Archived entries
    activeEntries: state.customEntries || [] // Active custom entries
  };
  
  const data = JSON.stringify(exportData, null, 2);
  const filename = `bag-of-lists-archive-${new Date().toISOString().slice(0,10)}.json`;
  saveDataToFile(data, 'application/json', filename);
  
  const totalEntries = exportData.entries.length + exportData.activeEntries.length;
  ui.notifications?.info(`Archive exported with ${totalEntries} entries (${exportData.entries.length} archived, ${exportData.activeEntries.length} active).`);
}

async function importArchive(fileInput) {
  return new Promise((resolve, reject) => {
    const file = fileInput.files?.[0];
    if (!file) {
      reject(new Error('No file selected'));
      return;
    }
    
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const data = JSON.parse(event.target.result);
        
        // Handle both old format (v1) and new format (v2)
        // v1: { entries: [...] } - only archived entries
        // v2: { version: 2, entries: [...], activeEntries: [...] } - both archived and active
        
        if (!Array.isArray(data.entries)) {
          throw new Error('Invalid archive format');
        }
        
        // Replace archived entries
        await saveArchive({ entries: data.entries });
        
        // If v2 format, also replace active custom entries
        if (data.version >= 2 && Array.isArray(data.activeEntries)) {
          const state = getState();
          state.customEntries = data.activeEntries;
          await saveState(state);
        } else {
          // v1 format: Clear active custom entries since old exports only captured archived state
          // This prevents duplicates when importing old-format archives
          const state = getState();
          state.customEntries = [];
          await saveState(state);
        }
        
        const archivedCount = data.entries.length;
        const activeCount = data.activeEntries?.length || 0;
        const totalCount = archivedCount + activeCount;
        
        ui.notifications?.info(`Archive restored: ${totalCount} entries (${archivedCount} archived, ${activeCount} active).`);
        resolve(totalCount);
      } catch (err) {
        ui.notifications?.error('Failed to import archive: ' + err.message);
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

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
          // Don't remove permanent dismissals - players should keep them regardless
          if (announcement.dismissedBy[targetId] === 'permanent') {
            continue;
          }
          // For temporary dismissals, only remove if user is not targeted or announcement doesn't pass
          const isTargeted = targetId === 'gm' || 
                             announcement.targets.includes(targetId) || 
                             announcement.targets.includes('all-players') ||
                             announcement.targets.includes('any-player');
          if (!isTargeted || !doesAnnouncementPassForTarget(announcement, page, targetId)) {
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
  if (!Array.isArray(announcement.targets)) return false;
  // Check if the announcement targets this user
  const isTargeted = announcement.targets.includes(targetId) || 
                     announcement.targets.includes('all-players') || 
                     announcement.targets.includes('any-player');
  if (!isTargeted) return false;
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
      // Don't reset permanent dismissals
      if (dismissedBy[targetId] === 'permanent') {
        continue;
      }
      // Check if user is still targeted
      const isTargeted = announcement.targets.includes(targetId) || 
                         announcement.targets.includes('all-players') || 
                         announcement.targets.includes('any-player');
      if (!isTargeted || !doesAnnouncementPassForTarget(announcement, page, targetId)) {
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
  
  // Get min/max values from faction settings, with defaults
  const minValue = faction.minValue ?? -50;
  const maxValue = faction.maxValue ?? 50;
  const clamped = Math.max(minValue, Math.min(maxValue, Number(value) || 0));
  
  // Calculate percentage for meter display
  const range = maxValue - minValue;
  let pct, posWidth, negWidth;
  
  if (minValue >= 0) {
    // Positive-only mode
    pct = range > 0 ? Math.min(1, Math.max(0, clamped / maxValue)) : 0;
    posWidth = Math.round(pct * 50);
    negWidth = 0;
  } else {
    // Standard mode with negative and positive values
    pct = range > 0 ? Math.min(1, Math.max(0, Math.abs(clamped) / Math.max(Math.abs(minValue), Math.abs(maxValue)))) : 0;
    posWidth = (clamped > 0) ? Math.round(pct * 50) : 0;
    negWidth = (clamped < 0) ? Math.round(pct * 50) : 0;
  }
  
  return {
    id: faction.id,
    name: faction.name,
    description: faction.description || '',
    linkedUuid: faction.linkedUuid || '',
    img: faction.img || "icons/svg/shield.svg",
    persistOnZero: !!faction.persistOnZero,
    playerControlled: faction.playerControlled ?? false,
    imgBgEnabled: faction.imgBgEnabled ?? false,
    imgBgClass: faction.imgBgClass || '',
    minValue,
    maxValue,
    value: clamped,
    posWidth,
    negWidth,
    imgScale: imgConfig.scale,
    imgOffsetX: imgConfig.offsetX,
    imgOffsetY: imgConfig.offsetY,
    imgEditorSize: imgConfig.editorSize,
    pageId: page.id
  };
}

class PortraitEditorApp extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
  constructor({ pageId, factionId, imgSrc, imgConfig, parentApp, isCharacterEditor = false, customEntryId = null, recipientId = null } = {}) {
    super({ id: `bol-portrait-editor-${foundry.utils.randomID()}` });
    this.pageId = pageId;
    this.factionId = factionId;
    this.imgSrc = imgSrc;
    this.parentApp = parentApp;
    this.isCharacterEditor = isCharacterEditor;
    this.customEntryId = customEntryId;
    this.recipientId = recipientId;
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
    if (this.isCharacterEditor) {
      // For character editor modal, update parent dialog's recipientData
      if (this.parentApp?.recipientData) {
        this.parentApp.recipientData.imgConfig = config;
        this.parentApp.render(true);
      }
      return;
    }
    
    // For custom entry editing from character icon row
    if (this.customEntryId) {
      const state = getState();
      state.customEntries ||= [];
      const entry = state.customEntries.find(e => e.id === this.customEntryId);
      if (entry) {
        entry.imgConfig = config;
        await saveState(state);
        const latest = getState();
        window._fr_temp_state = latest;
        if (this.parentApp?.rendered) {
          this.parentApp.render(true);
        }
      }
      return;
    }
    
    if (game.user.isGM) {
      const state = getState();
      const page = state.pages?.find?.(p => p.id === this.pageId);
      if (!page) throw new Error('Page not found for portrait update');
      const faction = page.factions?.find?.(f => f.id === this.factionId);
      if (!faction) throw new Error('Faction not found for portrait update');
      faction.imgConfig = config;
      
      // Update parent dialog's factionData if it's EditBagDialog
      if (this.parentApp?.factionData) {
        this.parentApp.factionData.imgConfig = config;
      }
      
      await saveState(state);
      const latest = getState();
      window._fr_temp_state = latest;
      if (this.parentApp?.rendered) {
        this.parentApp.render(true);
      }
    } else if (game.bagOfListsSocket) {
      // Optimistic update for player
      const state = getState();
      const page = state.pages?.find?.(p => p.id === this.pageId);
      if (page) {
        const faction = page.factions?.find?.(f => f.id === this.factionId);
        if (faction) {
          faction.imgConfig = config;
          window._fr_temp_state = { ...state };
          if (this.parentApp?.rendered) {
            this.parentApp.render(true);
          }
        }
      }
      
      // Send to GM for persistence
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

/** ------- Edit/Add Bag Dialog (ApplicationV2) ------- **/
class EditBagDialog extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
  constructor({ pageId, factionId, factionData, parentApp, isNew = false } = {}) {
    super({ id: `bol-edit-bag-${foundry.utils.randomID()}` });
    this.pageId = pageId;
    this.factionId = factionId;
    this.factionData = factionData || {};
    this.parentApp = parentApp;
    this.isNew = isNew;
  }

  static DEFAULT_OPTIONS = {
    id: 'bol-edit-bag-dialog',
    tag: 'form',
    window: {
      title: 'Edit/Add Bag',
      resizable: false,
      minimizable: false
    },
    position: {
      width: 400,
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
      template: 'modules/bag-of-lists/templates/edit-bag-dialog.hbs'
    }
  };

  async _prepareContext() {
    const imgConfig = normalizeImageConfig(this.factionData.imgConfig);
    const minValue = this.factionData.minValue ?? -50;
    const maxValue = this.factionData.maxValue ?? 50;
    
    return {
      name: this.factionData.name || '',
      description: this.factionData.description || '',
      linkedUuid: this.factionData.linkedUuid || '',
      img: this.factionData.img || 'icons/svg/shield.svg',
      persistOnZero: !!this.factionData.persistOnZero,
      playerControlled: this.factionData.playerControlled ?? false,
      imgBgEnabled: this.factionData.imgBgEnabled ?? false,
      imgBgClass: this.factionData.imgBgClass || '',
      minValue,
      maxValue,
      imgScale: imgConfig.scale,
      imgOffsetX: imgConfig.offsetX,
      imgOffsetY: imgConfig.offsetY,
      imgEditorSize: imgConfig.editorSize,
      isNew: this.isNew,
      highContrast: game.settings.get(MODULE_ID, 'highContrast')
    };
  }

  _onRender(context, options) {
    const html = this.element;
    const $html = $(html);
    
    // Apply image transforms
    applyImageTransforms(html);
    
    // Change icon button
    $html.find('.bol-change-icon-btn').on('click', () => {
      const fp = new FilePicker({
        type: 'image',
        callback: (path) => {
          this.factionData.img = path;
          this.factionData.imgConfig = defaultImageConfig();
          this.render(true);
        }
      });
      fp.render(true);
    });
    
    // Adjust Framing button
    $html.find('.bol-adjust-frame-btn').on('click', () => {
      const imgConfig = normalizeImageConfig(this.factionData.imgConfig);
      const imgSrc = this.factionData.img || 'icons/svg/shield.svg';
      const editor = new PortraitEditorApp({
        pageId: this.pageId,
        factionId: this.factionId,
        imgSrc,
        imgConfig,
        parentApp: this
      });
      editor.render(true);
    });
    
    // UUID Clear button
    $html.find('.bol-uuid-clear-btn').on('click', () => {
      $html.find('#bol-bag-uuid').val('');
      $html.find('.bol-uuid-open-btn').prop('disabled', true);
    });
    
    // UUID Open button - open the linked document
    $html.find('.bol-uuid-open-btn').on('click', async () => {
      const uuid = $html.find('#bol-bag-uuid').val()?.trim();
      if (!uuid) return;
      try {
        const doc = await fromUuid(uuid);
        if (doc?.sheet) {
          doc.sheet.render(true);
        } else {
          ui.notifications?.warn('Could not open the linked item.');
        }
      } catch (err) {
        logError('Failed to open linked UUID', err);
        ui.notifications?.error('Invalid UUID or item not found.');
      }
    });
    
    // UUID input change - enable/disable open button
    $html.find('#bol-bag-uuid').on('input', (ev) => {
      const hasValue = !!ev.currentTarget.value.trim();
      $html.find('.bol-uuid-open-btn').prop('disabled', !hasValue);
    });
    
    // UUID drag-drop support
    const uuidInput = $html.find('#bol-bag-uuid')[0];
    if (uuidInput) {
      uuidInput.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'link';
      });
      
      uuidInput.addEventListener('drop', async (ev) => {
        ev.preventDefault();
        try {
          const data = JSON.parse(ev.dataTransfer.getData('text/plain'));
          if (data.uuid) {
            uuidInput.value = data.uuid;
            $html.find('.bol-uuid-open-btn').prop('disabled', false);
          }
        } catch (err) {
          // Try to parse as plain UUID string
          const text = ev.dataTransfer.getData('text/plain')?.trim();
          if (text && text.includes('.')) {
            uuidInput.value = text;
            $html.find('.bol-uuid-open-btn').prop('disabled', false);
          }
        }
      });
    }
    
    // Background toggle
    $html.find('#bol-bag-bg-toggle').on('change', (ev) => {
      const enabled = ev.currentTarget.checked;
      this.factionData.imgBgEnabled = enabled;
      this.render(true);
    });
    
    // Background color selector
    $html.find('#bol-bag-bg-select').on('change', (ev) => {
      const bgClass = ev.currentTarget.value;
      this.factionData.imgBgClass = bgClass;
      if (bgClass && !this.factionData.imgBgEnabled) {
        this.factionData.imgBgEnabled = true;
      }
      this.render(true);
    });
    
    // Save button
    $html.find('.bol-save-btn').on('click', async () => {
      await this._handleSave($html);
    });
    
    // Delete button
    $html.find('.bol-delete-btn').on('click', async () => {
      await this._handleDelete();
    });
    
    // Enter key in name field saves
    $html.find('#bol-bag-name').on('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this._handleSave($html);
      }
    });
  }

  async _handleSave($html) {
    const name = $html.find('#bol-bag-name').val()?.trim();
    if (!name) {
      ui.notifications?.warn('Please enter a name for the item.');
      return;
    }
    
    const description = $html.find('#bol-bag-description').val()?.trim() || '';
    const linkedUuid = $html.find('#bol-bag-uuid').val()?.trim() || '';
    const persistOnZero = $html.find('#bol-persist-zero').is(':checked');
    const playerControlled = $html.find('#bol-player-controlled').is(':checked');
    
    // Read min/max values from inputs
    const minInput = $html.find('#bol-min-value').val()?.trim();
    const maxInput = $html.find('#bol-max-value').val()?.trim();
    let minValue = minInput !== '' ? Number(minInput) : -50;
    let maxValue = maxInput !== '' ? Number(maxInput) : 50;
    if (isNaN(minValue)) minValue = -50;
    if (isNaN(maxValue)) maxValue = 50;
    
    // Validate min/max
    if (minValue >= maxValue) {
      ui.notifications?.warn('Maximum value must be greater than minimum value.');
      return;
    }
    
    const state = getState();
    const page = state.pages.find(p => p.id === this.pageId);
    if (!page) {
      ui.notifications?.error('Page not found.');
      return;
    }
    
    if (this.isNew) {
      // Add new faction
      const newFaction = {
        id: foundry.utils.randomID(),
        name,
        description,
        linkedUuid,
        img: this.factionData.img || 'icons/svg/shield.svg',
        persistOnZero,
        playerControlled,
        minValue,
        maxValue,
        imgConfig: this.factionData.imgConfig || defaultImageConfig(),
        imgBgEnabled: this.factionData.imgBgEnabled ?? false,
        imgBgClass: this.factionData.imgBgClass || ''
      };
      page.factions.push(newFaction);
    } else {
      // Update existing faction
      const faction = page.factions.find(f => f.id === this.factionId);
      if (faction) {
        faction.name = name;
        faction.description = description;
        faction.linkedUuid = linkedUuid;
        faction.persistOnZero = persistOnZero;
        faction.playerControlled = playerControlled;
        faction.minValue = minValue;
        faction.maxValue = maxValue;
        faction.img = this.factionData.img || faction.img;
        if (this.factionData.imgConfig) {
          faction.imgConfig = this.factionData.imgConfig;
        }
        faction.imgBgEnabled = this.factionData.imgBgEnabled ?? false;
        faction.imgBgClass = this.factionData.imgBgClass || '';
      }
    }
    
    await saveState(state);
    const latestState = getState();
    window._fr_temp_state = latestState;
    
    if (this.parentApp?.rendered) {
      this.parentApp.render(true);
    }
    
    this.close();
  }

  async _handleDelete() {
    if (this.isNew) {
      this.close();
      return;
    }
    
    const confirm = await Dialog.confirm({
      title: 'Delete Item',
      content: `<p>Are you sure you want to delete "${this.factionData.name}"? This cannot be undone.</p>`,
      yes: () => true,
      no: () => false,
      defaultYes: false
    });
    
    if (!confirm) return;
    
    const state = getState();
    const page = state.pages.find(p => p.id === this.pageId);
    if (page) {
      page.factions = page.factions.filter(f => f.id !== this.factionId);
      // Clean up relations and announcements
      for (const uid of Object.keys(page.userRelations ?? {})) {
        if (page.userRelations[uid]) delete page.userRelations[uid][this.factionId];
      }
      if (Array.isArray(page.announcements)) {
        page.announcements = page.announcements.filter(a => a.factionId !== this.factionId);
      }
    }
    
    await saveState(state);
    const latestState = getState();
    window._fr_temp_state = latestState;
    
    if (this.parentApp?.rendered) {
      this.parentApp.render(true);
    }
    
    this.close();
  }
}

/** ------- Edit/Add Character Dialog (ApplicationV2) ------- **/
class EditCharacterDialog extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
  constructor({ recipientId, recipientData, parentApp, isNew = false, isCustom = false } = {}) {
    super({ id: `bol-edit-character-${foundry.utils.randomID()}` });
    this.recipientId = recipientId;
    this.recipientData = recipientData || {};
    this.parentApp = parentApp;
    this.isNew = isNew;
    this.isCustom = isCustom;
  }

  static DEFAULT_OPTIONS = {
    id: 'bol-edit-character-dialog',
    tag: 'form',
    window: {
      title: 'Edit/Add Character',
      resizable: false,
      minimizable: false
    },
    position: {
      width: 400,
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
      template: 'modules/bag-of-lists/templates/edit-character-dialog.hbs'
    }
  };

  async _prepareContext() {
    // For players, try to get their character/actor image
    let img = this.recipientData.img || 'icons/svg/mystery-man.svg';
    if (!this.isCustom && this.recipientId) {
      const user = game.users?.get(this.recipientId);
      if (user?.character?.img) {
        img = user.character.img;
      } else if (user?.avatar) {
        img = user.avatar;
      }
    }
    
    const imgConfig = normalizeImageConfig(this.recipientData.imgConfig);
    return {
      name: this.recipientData.name || '',
      img,
      showIcon: this.recipientData.showIcon ?? true,
      isNew: this.isNew,
      isCustom: this.isCustom,
      imgScale: imgConfig.scale,
      imgOffsetX: imgConfig.offsetX,
      imgOffsetY: imgConfig.offsetY,
      imgEditorSize: imgConfig.editorSize,
      imgBgEnabled: this.recipientData.imgBgEnabled ?? false,
      imgBgClass: this.recipientData.imgBgClass || '',
      highContrast: game.settings.get(MODULE_ID, 'highContrast')
    };
  }

  _onRender(context, options) {
    const html = this.element;
    const $html = $(html);
    
    // Apply image transforms
    applyImageTransforms(html);
    
    // Change icon button
    $html.find('.bol-change-icon-btn').on('click', () => {
      const fp = new FilePicker({
        type: 'image',
        callback: (path) => {
          this.recipientData.img = path;
          this.recipientData.imgConfig = defaultImageConfig();
          this.render(true);
        }
      });
      fp.render(true);
    });
    
    // Adjust Framing button
    $html.find('.bol-adjust-frame-btn').on('click', () => {
      const imgConfig = normalizeImageConfig(this.recipientData.imgConfig);
      const imgSrc = this.recipientData.img || 'icons/svg/mystery-man.svg';
      const editor = new PortraitEditorApp({
        pageId: null,
        factionId: this.recipientId,
        imgSrc,
        imgConfig,
        parentApp: this,
        isCharacterEditor: true
      });
      editor.render(true);
    });
    
    // Background toggle
    $html.find('#bol-char-bg-toggle').on('change', (ev) => {
      const enabled = ev.currentTarget.checked;
      this.recipientData.imgBgEnabled = enabled;
      this.render(true);
    });
    
    // Background color selector
    $html.find('#bol-char-bg-select').on('change', (ev) => {
      const bgClass = ev.currentTarget.value;
      this.recipientData.imgBgClass = bgClass;
      if (bgClass && !this.recipientData.imgBgEnabled) {
        this.recipientData.imgBgEnabled = true;
      }
      this.render(true);
    });
    
    // Save button
    $html.find('.bol-save-btn').on('click', async () => {
      await this._handleSave($html);
    });
    
    // Delete button
    $html.find('.bol-delete-btn').on('click', async () => {
      await this._handleDelete();
    });
    
    // Enter key in name field saves
    $html.find('#bol-char-name').on('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this._handleSave($html);
      }
    });
  }

  async _handleSave($html) {
    const name = $html.find('#bol-char-name').val()?.trim();
    if (!name && this.isCustom) {
      ui.notifications?.warn('Please enter a name for the custom entry.');
      return;
    }
    
    const showIcon = $html.find('#bol-show-icon').is(':checked');
    
    const state = getState();
    
    if (this.isCustom) {
      if (this.isNew) {
        // Add new custom entry
        state.customEntries ||= [];
        const newEntry = {
          id: `custom-${foundry.utils.randomID()}`,
          name,
          sharedToPlayers: false,
          showIcon,
          img: this.recipientData.img || 'icons/svg/mystery-man.svg',
          imgConfig: this.recipientData.imgConfig || defaultImageConfig(),
          imgBgEnabled: this.recipientData.imgBgEnabled ?? false,
          imgBgClass: this.recipientData.imgBgClass || ''
        };
        state.customEntries.push(newEntry);
      } else {
        // Update existing custom entry
        state.customEntries ||= [];
        const entry = state.customEntries.find(e => e.id === this.recipientId);
        if (entry) {
          entry.name = name;
          entry.showIcon = showIcon;
          if (this.recipientData.img) {
            entry.img = this.recipientData.img;
          }
          if (this.recipientData.imgConfig) {
            entry.imgConfig = this.recipientData.imgConfig;
          }
          entry.imgBgEnabled = this.recipientData.imgBgEnabled ?? false;
          entry.imgBgClass = this.recipientData.imgBgClass || '';
        }
      }
    } else {
      // For players, we store their display preferences in a separate structure
      state.recipientPrefs ||= {};
      state.recipientPrefs[this.recipientId] = {
        showIcon,
        customImg: this.recipientData.img || null,
        imgConfig: this.recipientData.imgConfig || defaultImageConfig(),
        imgBgEnabled: this.recipientData.imgBgEnabled ?? false,
        imgBgClass: this.recipientData.imgBgClass || ''
      };
    }
    
    await saveState(state);
    const latestState = getState();
    window._fr_temp_state = latestState;
    
    if (this.parentApp?.rendered) {
      this.parentApp.render(true);
    }
    
    this.close();
  }

  async _handleDelete() {
    if (this.isNew || !this.isCustom) {
      // Can't delete players from here, only custom entries
      this.close();
      return;
    }
    
    const confirm = await Dialog.confirm({
      title: 'Delete Custom Entry',
      content: `<p>Are you sure you want to delete "${this.recipientData.name}"? This cannot be undone.</p>`,
      yes: () => true,
      no: () => false,
      defaultYes: false
    });
    
    if (!confirm) return;
    
    const state = getState();
    state.customEntries ||= [];
    const index = state.customEntries.findIndex(entry => entry.id === this.recipientId);
    if (index !== -1) {
      state.customEntries.splice(index, 1);
    }
    // Clean up relations
    for (const page of state.pages ?? []) {
      if (page.userRelations?.[this.recipientId]) {
        delete page.userRelations[this.recipientId];
      }
    }
    
    await saveState(state);
    const latestState = getState();
    window._fr_temp_state = latestState;
    
    if (this.parentApp?.rendered) {
      this.parentApp.render(true);
    }
    
    this.close();
  }
}

/** ------- Archive Dialog (ApplicationV2) ------- **/
class ArchiveDialog extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
  constructor({ parentApp } = {}) {
    super({ id: `bol-archive-${foundry.utils.randomID()}` });
    this.parentApp = parentApp;
  }

  static DEFAULT_OPTIONS = {
    id: 'bol-archive-dialog',
    tag: 'form',
    window: {
      title: 'Entry Archive',
      resizable: true,
      minimizable: true
    },
    position: {
      width: 500,
      height: 400
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
      template: 'modules/bag-of-lists/templates/archive-dialog.hbs'
    }
  };

  async _prepareContext() {
    const archive = getArchive();
    const state = getState();
    
    // Format archived entries for display
    const archivedEntries = (archive.entries || []).map(entry => {
      const archivedDate = entry.archivedAt ? new Date(entry.archivedAt).toLocaleDateString() : 'Unknown';
      return {
        id: entry.id,
        name: entry.name || 'Unnamed Entry',
        img: entry.img || 'icons/svg/mystery-man.svg',
        archivedDate
      };
    });
    
    // Format active custom entries that can be archived
    const activeEntries = (state.customEntries || []).map(entry => ({
      id: entry.id,
      name: entry.name || 'Unnamed Entry',
      img: entry.img || 'icons/svg/mystery-man.svg'
    }));
    
    return {
      archivedEntries,
      activeEntries,
      hasArchivedEntries: archivedEntries.length > 0,
      hasActiveEntries: activeEntries.length > 0,
      highContrast: game.settings.get(MODULE_ID, 'highContrast')
    };
  }

  _onRender(context, options) {
    const html = this.element;
    const $html = $(html);
    
    // Archive an active entry
    $html.find('.bol-archive-entry-btn').on('click', async (ev) => {
      const entryId = ev.currentTarget.dataset.entryId;
      if (!entryId) return;
      
      const success = await archiveEntry(entryId);
      if (success) {
        ui.notifications?.info('Entry archived successfully.');
        this.render(true);
        if (this.parentApp?.rendered) {
          window._fr_temp_state = getState();
          this.parentApp.render(false); // Don't bring to front
        }
        // Keep this dialog focused
        setTimeout(() => this.bringToFront(), 10);
      }
    });
    
    // Restore an archived entry
    $html.find('.bol-restore-entry-btn').on('click', async (ev) => {
      const entryId = ev.currentTarget.dataset.entryId;
      if (!entryId) return;
      
      const success = await restoreEntry(entryId);
      if (success) {
        ui.notifications?.info('Entry restored successfully.');
        this.render(true);
        if (this.parentApp?.rendered) {
          window._fr_temp_state = getState();
          this.parentApp.render(false); // Don't bring to front
        }
        // Keep this dialog focused
        setTimeout(() => this.bringToFront(), 10);
      }
    });
    
    // Delete an archived entry permanently
    $html.find('.bol-delete-archived-btn').on('click', async (ev) => {
      const entryId = ev.currentTarget.dataset.entryId;
      if (!entryId) return;
      
      const confirmed = await Dialog.confirm({
        title: 'Delete Archived Entry',
        content: '<p>Are you sure you want to permanently delete this archived entry? This cannot be undone.</p>'
      });
      
      if (confirmed) {
        const success = await deleteArchivedEntry(entryId);
        if (success) {
          ui.notifications?.info('Archived entry deleted.');
          this.render(true);
        }
      }
    });
    
    // Export archive
    $html.find('#bol-export-archive').on('click', () => {
      exportArchive();
    });
    
    // Import archive
    $html.find('#bol-import-archive').on('click', async () => {
      // Check if confirmation is enabled
      const confirmEnabled = game.settings.get(MODULE_ID, 'confirmImport');
      
      let confirmed = true;
      if (confirmEnabled) {
        confirmed = await Dialog.confirm({
          title: 'Import Archive',
          content: '<p>Importing will <strong>replace</strong> all current custom entries (both active and archived) with the data from the file.</p><p>This cannot be undone. Continue?</p>'
        });
      }
      
      if (confirmed) {
        $html.find('#bol-import-archive-file').click();
      }
    });
    
    $html.find('#bol-import-archive-file').on('change', async (ev) => {
      try {
        await importArchive(ev.currentTarget);
        this.render(true);
        // Also refresh the parent tracker app since active entries may have changed
        if (this.parentApp?.rendered) {
          window._fr_temp_state = getState();
          this.parentApp.render(false); // Don't bring to front
        }
        // Keep this dialog focused
        setTimeout(() => this.bringToFront(), 10);
      } catch (err) {
        logError('Import failed', err);
      }
      // Reset the file input
      ev.currentTarget.value = '';
    });
  }
}

/** ------- Announcements Dialog (ApplicationV2) ------- **/
class AnnouncementsDialog extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
  constructor({ pageId, parentApp } = {}) {
    super({ id: `bol-announcements-${foundry.utils.randomID()}` });
    this.pageId = pageId;
    this.parentApp = parentApp;
  }

  static DEFAULT_OPTIONS = {
    id: 'bol-announcements-dialog',
    tag: 'form',
    window: {
      title: 'Announcements',
      resizable: true,
      minimizable: true
    },
    position: {
      width: 500,
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
      template: 'modules/bag-of-lists/templates/announcements-dialog.hbs'
    }
  };

  async _prepareContext() {
    const state = window._fr_temp_state || getState();
    const page = state.pages.find(p => p.id === this.pageId) || state.pages.find(p => p.id === state.activePageId);
    
    if (!page) {
      return {
        announcementTargets: [],
        announcementAudienceOptions: [],
        announcementSavedList: [],
        announcementSelectedId: null,
        gmAnnouncementAlerts: []
      };
    }
    
    const players = (game.users?.contents ?? game.users).filter(u => !u.isGM);
    
    const announcementTargets = page.factions.map(f => ({
      id: f.id,
      name: f.name
    }));
    
    const announcementAudienceOptions = [
      { id: 'gm', name: 'GM' },
      { id: 'any-player', name: '🎯 Any Player (first to trigger)' },
      { id: 'all-players', name: '👥 All Players' },
      ...players.map(p => ({ id: p.id, name: p.name }))
    ];
    
    const userNameLookup = new Map([
      ['gm', 'GM'],
      ['any-player', 'Any Player'],
      ['all-players', 'All Players'],
      ...players.map(p => [p.id, p.name])
    ]);
    
    const gmAnnouncements = (page.announcements || []).map(announcement => {
      const targetFaction = page.factions.find(f => f.id === announcement.factionId);
      const operatorKey = announcement.operator === 'ge' ? 'ge' : 'le';
      const operatorSymbol = operatorKey === 'ge' ? '≥' : '≤';
      const numericThreshold = Number(announcement.threshold);
      const thresholdDisplay = Number.isFinite(numericThreshold) ? numericThreshold : (announcement.threshold ?? '');
      const targets = Array.isArray(announcement.targets) && announcement.targets.length ? announcement.targets : ['gm'];
      const targetNames = targets.map(t => userNameLookup.get(t) ?? 'Unknown');
      const display = `${targetFaction?.name ?? 'Unknown Item'} ${operatorSymbol} ${thresholdDisplay} : ${announcement.message ?? ''}`.trim();
      return {
        id: announcement.id,
        display,
        targetSummary: targetNames.join(', '),
        thresholdNumeric: Number.isFinite(numericThreshold) ? numericThreshold : null,
        sendToChat: !!announcement.sendToChat
      };
    });
    
    let announcementSelectedId = window._fr_lastAnnouncementSelectedId;
    if (!gmAnnouncements.some(ann => ann.id === announcementSelectedId)) {
      announcementSelectedId = gmAnnouncements[0]?.id ?? null;
    }
    
    // Build alerts
    const gmAnnouncementAlerts = [];
    const allPlayers = game.users.filter(u => !u.isGM && u.active);
    
    for (const ann of gmAnnouncements) {
      if (ann.thresholdNumeric === null) continue;
      const fullAnn = page.announcements.find(a => a.id === ann.id);
      if (!fullAnn) continue;
      const hits = [];
      const targets = fullAnn.targets || [];
      const isAnyPlayer = targets.includes('any-player');
      const isAllPlayers = targets.includes('all-players');
      
      // Determine which players to check
      let playersToCheck = [];
      if (isAnyPlayer || isAllPlayers) {
        playersToCheck = allPlayers.map(p => p.id);
      } else {
        playersToCheck = targets.filter(t => t !== 'gm');
      }
      
      for (const targetId of playersToCheck) {
        const rawValue = page.userRelations?.[targetId]?.[fullAnn.factionId];
        const value = Number(rawValue);
        if (!Number.isFinite(value)) continue;
        const passes = fullAnn.operator === 'ge' ? value >= ann.thresholdNumeric : value <= ann.thresholdNumeric;
        if (passes) {
          hits.push({ targetId, value });
        }
      }
      if (!hits.length) continue;
      
      // For any-player mode, only show if not already triggered (no dismissals)
      if (isAnyPlayer && fullAnn.dismissedBy && Object.keys(fullAnn.dismissedBy).length > 0) continue;
      
      const detailText = hits.map(hit => {
        const name = userNameLookup.get(hit.targetId) ?? game.users.get(hit.targetId)?.name ?? 'Unknown';
        return `${name} (${hit.value})`;
      }).join(', ');
      
      const prefix = isAnyPlayer ? '[Any] ' : (isAllPlayers ? '[All] ' : '');
      gmAnnouncementAlerts.push({
        id: ann.id,
        display: prefix + ann.display,
        details: detailText ? `Triggered by: ${detailText}` : '',
        sendToChat: ann.sendToChat
      });
    }
    
    return {
      announcementTargets,
      announcementAudienceOptions,
      announcementSavedList: gmAnnouncements,
      announcementSelectedId,
      gmAnnouncementAlerts,
      highContrast: game.settings.get(MODULE_ID, 'highContrast')
    };
  }

  _onRender(context, options) {
    const html = this.element;
    const $html = $(html);
    
    // Bring window to front
    this.bringToFront();
    
    // Helper to populate form with announcement data for editing (defined early so we can use it)
    const populateFormWithAnnouncement = (announcement) => {
      // Set item dropdown
      $html.find('#fr-announcement-target').val(announcement.factionId);
      
      // Set recipients
      const recipientsSelect = $html.find('#fr-announcement-recipients')[0];
      if (recipientsSelect) {
        for (const opt of recipientsSelect.options) {
          opt.selected = announcement.targets?.includes(opt.value) ?? false;
        }
      }
      
      // Set operator
      const opButton = $html.find('#fr-announcement-operator')[0];
      if (opButton) {
        opButton.dataset.operator = announcement.operator || 'le';
        opButton.textContent = announcement.operator === 'ge' ? '≥' : '≤';
      }
      
      // Set threshold and message
      $html.find('#fr-announcement-threshold').val(announcement.threshold ?? '');
      $html.find('#fr-announcement-message').val(announcement.message ?? '');
      
      // Set chat options
      $html.find('#fr-announcement-send-chat').prop('checked', !!announcement.sendToChat);
      $html.find('#fr-announcement-chat-details').prop('checked', announcement.chatIncludeDetails !== false);
      
      // Set chat recipients
      const chatRecipientsSelect = $html.find('#fr-announcement-chat-recipients')[0];
      if (chatRecipientsSelect && Array.isArray(announcement.chatRecipients)) {
        const recipientsSet = new Set(announcement.chatRecipients);
        for (const opt of chatRecipientsSelect.options) {
          opt.selected = recipientsSet.has(opt.value);
        }
      }
    };
    
    // Check if we have a pending edit to populate
    if (window._fr_editingAnnouncement) {
      const announcement = window._fr_editingAnnouncement;
      window._fr_editingAnnouncement = null;
      // Use setTimeout to ensure DOM is ready
      setTimeout(() => {
        populateFormWithAnnouncement(announcement);
        // Update chat recipients visibility
        const sendToChat = $html.find('#fr-announcement-send-chat').is(':checked');
        $html.find('#fr-chat-recipients-row').toggle(sendToChat);
        $html.find('#fr-announcement-message').focus();
      }, 0);
    }
    
    // Restore last selected recipients (only if not editing)
    const recipientsSelectEl = $html.find('#fr-announcement-recipients')[0];
    if (recipientsSelectEl && !window._fr_editingAnnouncement) {
      const lastRecipients = Array.isArray(window._fr_lastAnnouncementRecipients) && window._fr_lastAnnouncementRecipients.length
        ? window._fr_lastAnnouncementRecipients
        : ['gm'];
      const allowedValues = new Set(Array.from(recipientsSelectEl.options).map(opt => opt.value));
      const appliedValues = lastRecipients.filter(value => allowedValues.has(value));
      const selectionSet = new Set(appliedValues.length ? appliedValues : ['gm']);
      for (const option of recipientsSelectEl.options) {
        option.selected = selectionSet.has(option.value);
      }
    }
    
    // Toggle chat recipients row visibility based on send to chat checkbox
    const updateChatRecipientsVisibility = () => {
      const sendToChat = $html.find('#fr-announcement-send-chat').is(':checked');
      $html.find('#fr-chat-recipients-row').toggle(sendToChat);
    };
    $html.find('#fr-announcement-send-chat').on('change', updateChatRecipientsVisibility);
    updateChatRecipientsVisibility();
    
    // Operator toggle
    $html.find('#fr-announcement-operator').on('click', (ev) => {
      const button = ev.currentTarget;
      const current = button.dataset.operator === 'ge' ? 'ge' : 'le';
      const next = current === 'le' ? 'ge' : 'le';
      button.dataset.operator = next;
      button.textContent = next === 'ge' ? '≥' : '≤';
    });
    
    // Recipients change
    $html.find('#fr-announcement-recipients').on('change', (ev) => {
      window._fr_lastAnnouncementRecipients = Array.from(ev.currentTarget.selectedOptions).map(opt => opt.value);
    });
    
    // Add announcement
    const addAnnouncement = async () => {
      const selectEl = $html.find('#fr-announcement-target')[0];
      const recipientsSelect = $html.find('#fr-announcement-recipients')[0];
      const thresholdInput = $html.find('#fr-announcement-threshold')[0];
      const messageInput = $html.find('#fr-announcement-message')[0];
      const operatorButton = $html.find('#fr-announcement-operator')[0];
      const sendToChatCheckbox = $html.find('#fr-announcement-send-chat')[0];
      const chatDetailsCheckbox = $html.find('#fr-announcement-chat-details')[0];
      const chatRecipientsSelect = $html.find('#fr-announcement-chat-recipients')[0];
      
      const factionId = selectEl?.value;
      const operator = operatorButton?.dataset.operator === 'ge' ? 'ge' : 'le';
      const thresholdValue = thresholdInput?.value?.trim() ?? '';
      const threshold = Number(thresholdValue);
      const message = messageInput?.value?.trim() ?? '';
      const targets = Array.from(recipientsSelect?.selectedOptions ?? []).map(opt => opt.value);
      const sendToChat = sendToChatCheckbox?.checked ?? false;
      const chatIncludeDetails = chatDetailsCheckbox?.checked ?? true;
      const chatRecipients = Array.from(chatRecipientsSelect?.selectedOptions ?? []).map(opt => opt.value);
      
      if (!factionId) return ui.notifications?.warn('Select an item to watch.');
      if (!Number.isFinite(threshold)) return ui.notifications?.warn('Enter a numeric threshold.');
      if (!message) return ui.notifications?.warn('Add a message for the announcement.');
      if (!targets.length) return ui.notifications?.warn('Select at least one recipient.');
      
      const state = getState();
      const page = state.pages.find(p => p.id === this.pageId) || state.pages.find(p => p.id === state.activePageId);
      if (!page) return;
      
      page.announcements ||= [];
      const newId = `announcement-${foundry.utils.randomID()}`;
      page.announcements.push({
        id: newId,
        factionId,
        operator,
        threshold,
        message,
        targets,
        sendToChat,
        chatIncludeDetails,
        chatRecipients: sendToChat ? (chatRecipients.length ? chatRecipients : ['gm']) : ['gm'],
        dismissedBy: {}
      });
      
      window._fr_lastAnnouncementRecipients = targets.slice();
      window._fr_lastAnnouncementSelectedId = newId;
      
      await saveState(state);
      const latestState = getState();
      window._fr_temp_state = latestState;
      
      if (messageInput) messageInput.value = '';
      if (thresholdInput) thresholdInput.value = '';
      
      this.render(true);
      if (this.parentApp?.rendered) {
        this.parentApp.render(true);
      }
      // Ensure window stays on top after render
      setTimeout(() => this.bringToFront(), 10);
    };
    
    $html.find('#fr-announcement-add').on('click', addAnnouncement);
    $html.find('#fr-announcement-message, #fr-announcement-threshold').on('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        addAnnouncement();
      }
    });
    
    // Selection change
    $html.find('#fr-announcement-saved').on('change', (ev) => {
      window._fr_lastAnnouncementSelectedId = ev.currentTarget?.value || null;
    });
    
    // Edit announcement - populate form with selected announcement data
    $html.find('#fr-announcement-edit').on('click', async () => {
      const selectEl = $html.find('#fr-announcement-saved')[0];
      const announcementId = selectEl?.value;
      if (!announcementId) return ui.notifications?.warn('Select an announcement to edit.');
      
      const state = getState();
      const page = state.pages.find(p => p.id === this.pageId) || state.pages.find(p => p.id === state.activePageId);
      if (!page?.announcements) return;
      
      const announcement = page.announcements.find(a => a.id === announcementId);
      if (!announcement) return;
      
      // Store the announcement data to populate after render
      window._fr_editingAnnouncement = foundry.utils.duplicate(announcement);
      
      // Delete the original so it can be re-added with edits
      const index = page.announcements.findIndex(a => a.id === announcementId);
      if (index !== -1) {
        page.announcements.splice(index, 1);
      }
      
      await saveState(state);
      const latestState = getState();
      window._fr_temp_state = latestState;
      
      ui.notifications?.info('Editing announcement. Make changes and click "Add Announcement" to save.');
      this.render(true);
    });
    
    // Delete announcement
    $html.find('#fr-announcement-delete').on('click', async () => {
      const selectEl = $html.find('#fr-announcement-saved')[0];
      const announcementId = selectEl?.value;
      if (!announcementId) return ui.notifications?.warn('Select an announcement to delete.');
      
      const state = getState();
      const page = state.pages.find(p => p.id === this.pageId) || state.pages.find(p => p.id === state.activePageId);
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
      if (this.parentApp?.rendered) {
        this.parentApp.render(true);
      }
      // Ensure window stays on top after render
      setTimeout(() => this.bringToFront(), 10);
    });
    
    // Duplicate announcement - creates copy and opens for editing
    $html.find('#fr-announcement-duplicate').on('click', async () => {
      const selectEl = $html.find('#fr-announcement-saved')[0];
      const announcementId = selectEl?.value;
      if (!announcementId) return ui.notifications?.warn('Select an announcement to duplicate.');
      
      const state = getState();
      const page = state.pages.find(p => p.id === this.pageId) || state.pages.find(p => p.id === state.activePageId);
      if (!page?.announcements) return;
      
      const original = page.announcements.find(a => a.id === announcementId);
      if (!original) return;
      
      // Populate form with the original data (for editing as new)
      populateFormWithAnnouncement(original);
      
      // Update chat recipients visibility
      const sendToChat = $html.find('#fr-announcement-send-chat').is(':checked');
      $html.find('#fr-chat-recipients-row').toggle(sendToChat);
      
      // Focus message input
      $html.find('#fr-announcement-message').focus();
      
      ui.notifications?.info('Duplicated to form. Make changes and click "Add Announcement" to save as new.');
    });
    
    // Duplicate to specific item
    $html.find('#fr-announcement-duplicate-to-item').on('click', async () => {
      const selectEl = $html.find('#fr-announcement-saved')[0];
      const targetItemSelect = $html.find('#fr-announcement-duplicate-target')[0];
      const announcementId = selectEl?.value;
      const targetFactionId = targetItemSelect?.value;
      
      if (!announcementId) return ui.notifications?.warn('Select an announcement to duplicate.');
      if (!targetFactionId) return ui.notifications?.warn('Select a target item.');
      
      const state = getState();
      const page = state.pages.find(p => p.id === this.pageId) || state.pages.find(p => p.id === state.activePageId);
      if (!page?.announcements) return;
      
      const original = page.announcements.find(a => a.id === announcementId);
      if (!original) return;
      
      if (original.factionId === targetFactionId) {
        return ui.notifications?.warn('Select a different item to duplicate to.');
      }
      
      const targetFaction = page.factions.find(f => f.id === targetFactionId);
      const newId = `announcement-${foundry.utils.randomID()}`;
      const duplicate = {
        ...foundry.utils.duplicate(original),
        id: newId,
        factionId: targetFactionId,
        dismissedBy: {}
      };
      page.announcements.push(duplicate);
      window._fr_lastAnnouncementSelectedId = newId;
      
      await saveState(state);
      const latestState = getState();
      window._fr_temp_state = latestState;
      
      ui.notifications?.info(`Announcement duplicated to "${targetFaction?.name ?? 'item'}".`);
      this.render(true);
      if (this.parentApp?.rendered) {
        this.parentApp.render(true);
      }
      // Ensure window stays on top after render
      setTimeout(() => this.bringToFront(), 10);
    });
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
      height: 600
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
      ...players.map(p => {
        const imgConfig = normalizeImageConfig(state.recipientPrefs?.[p.id]?.imgConfig);
        return {
          id: p.id,
          name: p.name,
          img: p.character?.img || p.avatar || 'icons/svg/mystery-man.svg',
          showIcon: state.recipientPrefs?.[p.id]?.showIcon ?? true,
          isCustom: false,
          isPlayer: true,
          sharedToPlayers: false,
          imgScale: imgConfig.scale,
          imgOffsetX: imgConfig.offsetX,
          imgOffsetY: imgConfig.offsetY,
          imgEditorSize: imgConfig.editorSize,
          imgBgEnabled: state.recipientPrefs?.[p.id]?.imgBgEnabled ?? false,
          imgBgClass: state.recipientPrefs?.[p.id]?.imgBgClass || ''
        };
      }),
      ...customEntries.map(entry => {
        const imgConfig = normalizeImageConfig(entry.imgConfig);
        return {
          id: entry.id,
          name: entry.name,
          img: entry.img || 'icons/svg/mystery-man.svg',
          showIcon: entry.showIcon ?? true,
          isCustom: true,
          isPlayer: false,
          sharedToPlayers: !!entry.sharedToPlayers,
          imgScale: imgConfig.scale,
          imgOffsetX: imgConfig.offsetX,
          imgOffsetY: imgConfig.offsetY,
          imgEditorSize: imgConfig.editorSize,
          imgBgEnabled: entry.imgBgEnabled ?? false,
          imgBgClass: entry.imgBgClass || ''
        };
      })
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
      const minValue = f.minValue ?? -50;
      const maxValue = f.maxValue ?? 50;
      
      const cells = gmRecipients.map(recipient => {
        const value = (activePage.userRelations?.[recipient.id]?.[f.id]) ?? 0;
        const clamped = Math.max(minValue, Math.min(maxValue, Number(value) || 0));
        
        // Calculate percentage for meter display
        const range = maxValue - minValue;
        let pct, posWidth, negWidth;
        
        if (minValue >= 0) {
          // Positive-only mode
          pct = range > 0 ? Math.min(1, Math.max(0, clamped / maxValue)) : 0;
          posWidth = Math.round(pct * 50);
          negWidth = 0;
        } else {
          // Standard mode with negative and positive values
          pct = range > 0 ? Math.min(1, Math.max(0, Math.abs(clamped) / Math.max(Math.abs(minValue), Math.abs(maxValue)))) : 0;
          posWidth = (clamped > 0) ? Math.round(pct * 50) : 0;
          negWidth = (clamped < 0) ? Math.round(pct * 50) : 0;
        }
        
        return {
          userId: recipient.id,
          isCustom: recipient.isCustom,
          value: clamped,
          posWidth,
          negWidth
        };
      });
      return {
        id: f.id,
        name: f.name,
        description: f.description || '',
        linkedUuid: f.linkedUuid || '',
        img: f.img || "icons/svg/shield.svg",
        persistOnZero: !!f.persistOnZero,
        playerControlled: f.playerControlled ?? false,
        minValue,
        maxValue,
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
      let permanentDismissals = [];

      if (activeTabType === 'page') {
        activePageId = activeTab.id;
        const activePlayerPage = playerPages.find(p => p.id === activePageId) || playerPages[0] || null;
        if (activePlayerPage) {
          pageName = activePlayerPage.name;
          myFactions = activePlayerPage.factions.map(f => buildFactionDisplay(activePlayerPage, me.id, f)).filter(Boolean);
          activePageId = activePlayerPage.id;
          const basePage = state.pages.find(p => p.id === activePlayerPage.id);
          
          // Merge local dismissals with server state to handle race conditions
          // But skip any announcements that were recently re-enabled by the player
          const localState = window._fr_temp_state;
          const localPage = localState?.pages?.find?.(p => p.id === activePlayerPage.id);
          if (localPage?.announcements && basePage?.announcements) {
            for (let i = 0; i < basePage.announcements.length; i++) {
              const serverAnn = basePage.announcements[i];
              const localAnn = localPage.announcements.find(a => a.id === serverAnn.id);
              const reenableKey = `${basePage.id}-${serverAnn.id}`;
              // Skip if this was recently re-enabled - let the server state take precedence
              if (window._fr_recently_reenabled?.has(reenableKey)) {
                continue;
              }
              if (localAnn?.dismissedBy?.[me.id]) {
                serverAnn.dismissedBy ||= {};
                serverAnn.dismissedBy[me.id] = localAnn.dismissedBy[me.id];
              }
            }
          }
          
          // Collect permanently dismissed announcements for this player
          if (basePage?.announcements) {
            for (const announcement of basePage.announcements) {
              if (announcement.dismissedBy?.[me.id] === 'permanent') {
                const faction = basePage.factions.find(f => f.id === announcement.factionId);
                if (faction) {
                  console.log(`[bag-of-lists] Found permanent dismissal for ${faction.name} announcement ${announcement.id}`);
                  permanentDismissals.push({
                    id: announcement.id,
                    pageId: basePage.id,
                    factionName: faction.name,
                    message: announcement.message || 'No message'
                  });
                }
              }
            }
          }
          
          if (basePage?.announcements?.length) {
            console.log(`[bag-of-lists] Checking ${basePage.announcements.length} announcements for player ${me.id}`);
            for (const announcement of basePage.announcements) {
              console.log(`[bag-of-lists] Announcement ${announcement.id} dismissedBy:`, announcement.dismissedBy);
              const targets = Array.isArray(announcement.targets) && announcement.targets.length ? announcement.targets : ['gm'];
              
              // Check if this player should see the announcement based on targeting
              const isAnyPlayer = targets.includes('any-player');
              const isAllPlayers = targets.includes('all-players');
              const isDirectlyTargeted = targets.includes(me.id);
              
              // For any-player: only show if no one has triggered it yet (check dismissedBy)
              // For all-players: show to everyone
              // For direct targeting: show only to targeted players
              if (!isDirectlyTargeted && !isAnyPlayer && !isAllPlayers) continue;
              
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
              
              // For any-player, skip if anyone has already dismissed it
              if (isAnyPlayer && announcement.dismissedBy && Object.keys(announcement.dismissedBy).length > 0) continue;
              
              // For regular targeting, skip if this user dismissed it (including permanent dismissals)
              // Check for both temporary (true) and permanent ('permanent') dismissals
              const userDismissal = announcement.dismissedBy?.[me.id];
              if (userDismissal === true || userDismissal === 'permanent') {
                console.log(`[bag-of-lists] Skipping announcement ${announcement.id} for ${faction.name} - dismissed by user (${userDismissal})`);
                continue;
              }
              
              const message = `${faction.name} ${operatorSymbol} ${thresholdNumeric} : ${announcement.message ?? ''}`.trim();
              announcementAlerts.push({
                id: announcement.id,
                display: message,
                value,
                pageId: basePage.id,
                sendToChat: !!announcement.sendToChat
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
        permanentDismissals,
        dismissalsCollapsed: window._fr_dismissals_collapsed ?? true,
        settings: {
          compactMode: game.settings.get(MODULE_ID, 'compactMode'),
          largeFonts: game.settings.get(MODULE_ID, 'largeFonts'),
          highContrast: game.settings.get(MODULE_ID, 'highContrast'),
          showPlayerNames: game.settings.get(MODULE_ID, 'showPlayerNames'),
          showTooltips: game.settings.get(MODULE_ID, 'showTooltips')
        },
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
      settings: {
        compactMode: game.settings.get(MODULE_ID, 'compactMode'),
        largeFonts: game.settings.get(MODULE_ID, 'largeFonts'),
        highContrast: game.settings.get(MODULE_ID, 'highContrast'),
        showPlayerNames: game.settings.get(MODULE_ID, 'showPlayerNames'),
        showTooltips: game.settings.get(MODULE_ID, 'showTooltips')
      },
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
    
    // Fix resize: ensure the window element has an explicit pixel height
    // so the browser's resize handle works on the very first drag.
    if (this.element) {
      const appEl = this.element.closest('.application');
      if (appEl) {
        const computedH = appEl.getBoundingClientRect().height;
        if (computedH > 0 && (!appEl.style.height || appEl.style.height === 'auto')) {
          appEl.style.height = `${computedH}px`;
        }
      }
    }
    
    // Apply image transforms for portraits
    applyImageTransforms(html);
    
    // Sync sticky header offsets: the column header row must sit below the icon row
    const iconRow = html.querySelector('.fr-character-icons-row');
    if (iconRow) {
      const headerRow = iconRow.nextElementSibling;
      if (headerRow) {
        const syncStickyOffset = () => {
          const iconRowHeight = iconRow.offsetHeight;
          headerRow.querySelectorAll('th').forEach(th => {
            th.style.top = `${iconRowHeight}px`;
          });
        };
        // Sync immediately and after images load (which may change row height)
        syncStickyOffset();
        iconRow.querySelectorAll('img').forEach(img => {
          if (!img.complete) img.addEventListener('load', syncStickyOffset, { once: true });
        });
      }
    }
    
    // Handle tooltips setting - remove data-tooltip attributes if disabled
    const showTooltips = game.settings.get(MODULE_ID, 'showTooltips');
    if (!showTooltips) {
      $html.find('[data-tooltip]').each((_, el) => {
        // Store the tooltip text in a different attribute in case we need it later
        el.dataset.tooltipDisabled = el.dataset.tooltip;
        el.removeAttribute('data-tooltip');
      });
    }
    
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
      
      const maxValue = faction.maxValue ?? 50;
      
      page.userRelations ||= {};
      page.userRelations[me.id] ||= {};
      let v = Number(page.userRelations[me.id][fid]) || 0;
      v = Math.min(maxValue, v + 1);
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
      
      const minValue = faction.minValue ?? -50;
      
      page.userRelations ||= {};
      page.userRelations[me.id] ||= {};
      let v = Number(page.userRelations[me.id][fid]) || 0;
      v = Math.max(minValue, v - 1);
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

    // Player: Direct value input for playerControlled items
    $html.find('.fr-player-value-input').on('change blur', async (ev) => {
      const input = ev.currentTarget;
      const fid = input.dataset.fid;
      const state = window._fr_temp_state || getState();
      const me = game.user;
      const pageId = input.dataset.pageid || state.activePageId;
      
      // Find active page and faction
      const page = (state.pages || []).find(p => p.id === pageId);
      if (!page) return;
      const faction = page.factions.find(f => f.id === fid);
      if (!faction || !faction.playerControlled) return;
      
      const minValue = faction.minValue ?? -50;
      const maxValue = faction.maxValue ?? 50;
      
      let v = Number(input.value) || 0;
      v = Math.max(minValue, Math.min(maxValue, Math.round(v)));
      
      page.userRelations ||= {};
      page.userRelations[me.id] ||= {};
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
    
    // Player: Enter key submits value input
    $html.find('.fr-player-value-input').on('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        ev.currentTarget.blur();
      }
    });

    $html.find('.fr-announcement-dismiss').on('click', async (ev) => {
      ev.preventDefault();
      const button = ev.currentTarget;
      const announcementId = button.dataset.announcementId;
      const pageId = button.dataset.pageid;
      if (!announcementId || !pageId) return;
      const currentUserId = game.user.id;
      
      // Check if 'Do Not Show Again' is checked
      const alertDiv = button.closest('.fr-announcement-alert');
      const noShowCheckbox = alertDiv?.querySelector('.fr-announcement-no-show');
      const permanentDismiss = noShowCheckbox?.checked ?? false;

      if (game.user.isGM) {
        const state = getState();
        const page = state.pages.find(p => p.id === pageId);
        if (!page) return;
        const announcement = page.announcements?.find?.(ann => ann.id === announcementId);
        if (!announcement) return;
        announcement.dismissedBy ||= {};
        if (permanentDismiss) {
          // Permanent dismiss - mark as dismissed and don't reset
          announcement.dismissedBy[currentUserId] = 'permanent';
        } else if (currentUserId !== 'gm') {
          announcement.dismissedBy[currentUserId] = true;
        }
        if (!permanentDismiss) {
          resetAnnouncementDismissalsForPage(page);
        }
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
        localAnnouncement.dismissedBy[currentUserId] = permanentDismiss ? 'permanent' : true;
      }
      this.render(true);

      if (hasSocket) {
        try {
          await game.bagOfListsSocket.executeAsGM('playerDismissAnnouncement', {
            announcementId,
            pageId,
            userId: currentUserId,
            permanent: permanentDismiss
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
    
    // Player: Toggle dismissals dropdown (persist state across re-renders)
    $html.find('.fr-dismissals-header').on('click', (ev) => {
      const header = ev.currentTarget;
      const list = header.parentElement?.querySelector('.fr-dismissals-list');
      const icon = header.querySelector('.fr-toggle-icon');
      if (list) {
        list.classList.toggle('fr-hidden');
        window._fr_dismissals_collapsed = list.classList.contains('fr-hidden');
        if (icon) {
          icon.textContent = window._fr_dismissals_collapsed ? '▶' : '▼';
        }
      }
    });
    
    // Player: Re-enable notification
    $html.find('.fr-reenable-notification').on('click', async (ev) => {
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
        if (announcement.dismissedBy?.[currentUserId]) {
          delete announcement.dismissedBy[currentUserId];
        }
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
      if (localAnnouncement?.dismissedBy?.[currentUserId]) {
        delete localAnnouncement.dismissedBy[currentUserId];
      }
      
      // Mark as recently re-enabled to prevent merge from re-adding the dismissal
      const reenableKey = `${pageId}-${announcementId}`;
      window._fr_recently_reenabled?.add(reenableKey);
      
      this.render(true);

      if (hasSocket) {
        try {
          await game.bagOfListsSocket.executeAsGM('playerReenableAnnouncement', {
            announcementId,
            pageId,
            userId: currentUserId
          });
          // Clear from recently re-enabled after GM confirms (give it a moment for state to sync)
          setTimeout(() => {
            window._fr_recently_reenabled?.delete(reenableKey);
          }, 2000);
        } catch (err) {
          logError('playerReenableAnnouncement failed', err);
          ui.notifications?.error?.('Failed to re-enable notification. Please try again.');
        } finally {
          if (button.isConnected) {
            button.disabled = false;
          }
        }
      } else {
        ui.notifications?.warn?.('Re-enable did not reach the GM—socket connection unavailable.');
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
    $html.find('.fr-tab').off('click');
    $html.find('#fr-add-page').off('click');
    $html.find('.fr-rename-page').off('click');
    $html.off('input', '.fr-rename-input');
    $html.off('blur change', '.fr-rename-input');
    $html.find('#fr-del-page').off('click');
    $html.find('#fr-add').off('click');
    $html.find('#fr-new-name').off('keydown');
    $html.find('#fr-open-announcements').off('click');
    $html.find('.fr-edit-bag-btn').off('click');
    $html.find('.fr-val-plus').off('click');
    $html.find('.fr-val-minus').off('click');
    $html.find('.fr-char-icon-wrapper').off('click');
    $html.find('.fr-char-icon-edit').off('click');
    $html.find('.fr-del').off('click');
    $html.find('.fr-del-custom').off('click');
    $html.find('.fr-img').off('click');
    $html.find('.fr-img-edit').off('click');
    $html.find('.fr-val').off('change blur');
    $html.find('.fr-share-custom').off('click');
    $html.find('.fr-custom-subtab').off('click');

    // --- Open Announcements Modal ---
    $html.find('#fr-open-announcements').on('click', (ev) => {
      ev.preventDefault();
      const state = window._fr_temp_state || getState();
      const dialog = new AnnouncementsDialog({
        pageId: state.activePageId,
        parentApp: this
      });
      dialog.render(true);
    });

    // --- Open Archive Dialog ---
    $html.find('#fr-open-archive').on('click', (ev) => {
      ev.preventDefault();
      const dialog = new ArchiveDialog({
        parentApp: this
      });
      dialog.render(true);
    });

    // --- Edit Bag Button ---
    $html.find('.fr-edit-bag-btn').on('click', (ev) => {
      ev.preventDefault();
      const fid = ev.currentTarget.dataset.fid;
      const pageId = ev.currentTarget.dataset.pageid || getState().activePageId;
      const state = window._fr_temp_state || getState();
      const page = state.pages.find(p => p.id === pageId);
      const faction = page?.factions?.find(f => f.id === fid);
      if (!page || !faction) return;
      
      const dialog = new EditBagDialog({
        pageId: page.id,
        factionId: fid,
        factionData: { ...faction },
        parentApp: this,
        isNew: false
      });
      dialog.render(true);
    });

    // --- Linked Name Click (Open UUID) ---
    $html.find('.fr-name-link').on('click', async (ev) => {
      ev.preventDefault();
      const uuid = ev.currentTarget.dataset.uuid;
      if (!uuid) return;
      try {
        const doc = await fromUuid(uuid);
        if (doc?.sheet) {
          doc.sheet.render(true);
        } else {
          ui.notifications?.warn('Could not open the linked item.');
        }
      } catch (err) {
        logError('Failed to open linked UUID', err);
        ui.notifications?.error('Invalid UUID or item not found.');
      }
    });

    // --- UUID Link Button Click ---
    $html.find('.fr-uuid-link-btn').on('click', async (ev) => {
      ev.preventDefault();
      const uuid = ev.currentTarget.dataset.uuid;
      if (!uuid) return;
      try {
        const doc = await fromUuid(uuid);
        if (doc?.sheet) {
          doc.sheet.render(true);
        } else {
          ui.notifications?.warn('Could not open the linked item.');
        }
      } catch (err) {
        logError('Failed to open linked UUID', err);
        ui.notifications?.error('Invalid UUID or item not found.');
      }
    });

    // --- +/- Value Buttons ---
    $html.find('.fr-val-plus').on('click', async (ev) => {
      ev.preventDefault();
      const fid = ev.currentTarget.dataset.fid;
      const uid = ev.currentTarget.dataset.uid;
      const state = getState();
      const page = state.pages.find(p => p.id === state.activePageId);
      if (page) {
        const faction = page.factions.find(f => f.id === fid);
        const maxValue = faction?.maxValue ?? 50;
        
        page.userRelations ||= {};
        page.userRelations[uid] ||= {};
        let v = Number(page.userRelations[uid][fid]) || 0;
        v = Math.min(maxValue, v + 1);
        page.userRelations[uid][fid] = v;
        resetAnnouncementDismissalsForPage(page);
        
        // Check and send chat messages for triggered announcements (only for this faction)
        checkAndSendAnnouncementChatMessages(page, uid, fid);
        
        await saveState(state);
        const latestState = getState();
        window._fr_temp_state = latestState;
        this.render(true);
      }
    });

    $html.find('.fr-val-minus').on('click', async (ev) => {
      ev.preventDefault();
      const fid = ev.currentTarget.dataset.fid;
      const uid = ev.currentTarget.dataset.uid;
      const state = getState();
      const page = state.pages.find(p => p.id === state.activePageId);
      if (page) {
        const faction = page.factions.find(f => f.id === fid);
        const minValue = faction?.minValue ?? -50;
        
        page.userRelations ||= {};
        page.userRelations[uid] ||= {};
        let v = Number(page.userRelations[uid][fid]) || 0;
        v = Math.max(minValue, v - 1);
        page.userRelations[uid][fid] = v;
        resetAnnouncementDismissalsForPage(page);
        
        // Check and send chat messages for triggered announcements (only for this faction)
        checkAndSendAnnouncementChatMessages(page, uid, fid);
        
        await saveState(state);
        const latestState = getState();
        window._fr_temp_state = latestState;
        this.render(true);
      }
    });

    // --- Add Character Button ---
    $html.find('#fr-add-character').on('click', (ev) => {
      ev.preventDefault();
      const dialog = new EditCharacterDialog({
        recipientId: null,
        recipientData: {},
        parentApp: this,
        isNew: true,
        isCustom: true
      });
      dialog.render(true);
    });

    // --- Character Icon Click (Edit Character) ---
    $html.find('.fr-char-icon-wrapper, .fr-char-icon-edit').on('click', (ev) => {
      ev.preventDefault();
      const uid = ev.currentTarget.dataset.uid;
      const isCustom = ev.currentTarget.dataset.iscustom === 'true';
      const state = window._fr_temp_state || getState();
      
      let recipientData = {};
      if (isCustom) {
        const entry = state.customEntries?.find(e => e.id === uid);
        if (entry) {
          recipientData = { ...entry };
        }
      } else {
        const user = game.users?.get(uid);
        if (user) {
          recipientData = {
            name: user.name,
            img: user.character?.img || user.avatar || 'icons/svg/mystery-man.svg',
            showIcon: state.recipientPrefs?.[uid]?.showIcon ?? true,
            imgConfig: state.recipientPrefs?.[uid]?.imgConfig || defaultImageConfig(),
            imgBgEnabled: state.recipientPrefs?.[uid]?.imgBgEnabled ?? false,
            imgBgClass: state.recipientPrefs?.[uid]?.imgBgClass || ''
          };
        }
      }
      
      const dialog = new EditCharacterDialog({
        recipientId: uid,
        recipientData,
        parentApp: this,
        isNew: false,
        isCustom
      });
      dialog.render(true);
    });

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
          // Select all text so user can immediately type to replace
          const inputEl = $newInput[0];
          if (inputEl && inputEl.select) {
            inputEl.select();
          }
        }
      }, 50);
    }

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
      
      // Check if user wants confirmation
      const confirmEnabled = game.settings.get(MODULE_ID, 'confirmDeletePage');
      
      let confirmed = true;
      if (confirmEnabled) {
        // Show confirmation dialog with "Don't show again" option
        const currentPage = state.pages.find(p => p.id === state.activePageId);
        const pageName = currentPage?.name || 'this page';
        
        const dialog = await Dialog.wait({
          title: 'Delete Page',
          content: `
            <div style="margin-bottom: 12px;">
              <p style="margin-bottom: 8px;"><strong>Are you sure you want to delete "${pageName}"?</strong></p>
              <p style="margin-bottom: 12px; color: #ff6b6b;">This will permanently delete the page and all items on it. This cannot be undone.</p>
              <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                <input type="checkbox" id="disable-confirmation" style="cursor: pointer;" />
                <span>Don't ask me again (can re-enable in settings)</span>
              </label>
            </div>
          `,
          buttons: {
            delete: {
              icon: '<i class="fas fa-trash"></i>',
              label: 'Delete Page',
              callback: (html) => {
                const disableConfirm = html.find('#disable-confirmation').is(':checked');
                return { confirmed: true, disableConfirm };
              }
            },
            cancel: {
              icon: '<i class="fas fa-times"></i>',
              label: 'Cancel',
              callback: () => ({ confirmed: false, disableConfirm: false })
            }
          },
          default: 'cancel'
        });
        
        if (!dialog) {
          confirmed = false;
        } else {
          confirmed = dialog.confirmed;
          if (dialog.disableConfirm) {
            await game.settings.set(MODULE_ID, 'confirmDeletePage', false);
          }
        }
      }
      
      if (!confirmed) return;
      
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
  // Get default values from settings
  const defaultImg = game.settings.get(MODULE_ID, 'defaultItemImage') || 'icons/svg/shield.svg';
  const defaultMin = game.settings.get(MODULE_ID, 'defaultMinValue') ?? -50;
  const defaultMax = game.settings.get(MODULE_ID, 'defaultMaxValue') ?? 50;
  
  // Default persistOnZero to false (GM can enable per item)
  page.factions.push({ 
    id: foundry.utils.randomID(), 
    name, 
    img: defaultImg, 
    persistOnZero: false, 
    playerControlled: false, 
    imgConfig: defaultImageConfig(),
    minValue: defaultMin,
    maxValue: defaultMax
  });
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
      
      // Check if confirmation is enabled
      const confirmEnabled = game.settings.get(MODULE_ID, 'confirmDeleteItem');
      const showArchiveReminder = game.settings.get(MODULE_ID, 'showArchiveReminder');
      
      let confirmed = true;
      if (confirmEnabled) {
        const state = getState();
        const page = state.pages.find(p => p.id === state.activePageId);
        const item = page?.factions?.find(f => f.id === fid);
        const itemName = item?.name || 'this item';
        
        const archiveReminderText = showArchiveReminder 
          ? '<p style="margin-bottom: 8px; color: #4caf50;">💡 Tip: You can archive items instead of deleting them using the Archive button.</p>'
          : '';
        
        confirmed = await Dialog.confirm({
          title: 'Delete Item',
          content: `
            <div>
              <p style="margin-bottom: 8px;">Are you sure you want to delete <strong>"${itemName}"</strong>?</p>
              <p style="margin-bottom: 8px; color: #ff6b6b;">This will permanently remove the item and all associated data.</p>
              ${archiveReminderText}
            </div>
          `
        });
      }
      
      if (!confirmed) return;
      
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
      const state = window._fr_temp_state || getState();
      const localActivePageId = ev.currentTarget.dataset.pageid || state.activePageId;
      const page = state.pages.find(p => p.id === localActivePageId);
      if (!page) return;
      const faction = page.factions.find(f => f.id === fid);
      if (!faction) return;
      // Optimistic local update
      faction.imgBgEnabled = enabled;
      // Preserve player's active page if different from GM's
      window._fr_temp_state = { ...state, activePageId: localActivePageId };
      this.render(true);
      if (game.user.isGM) {
        await saveState(state);
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
      const state = window._fr_temp_state || getState();
      const localActivePageId = ev.currentTarget.dataset.pageid || state.activePageId;
      const page = state.pages.find(p => p.id === localActivePageId);
      if (!page) return;
      const faction = page.factions.find(f => f.id === fid);
      if (!faction) return;
      faction.imgBgClass = bgClass;
      if (bgClass && !faction.imgBgEnabled) faction.imgBgEnabled = true;
      window._fr_temp_state = { ...state, activePageId: localActivePageId }; // optimistic
      // Close dropdown
      const dd = ev.currentTarget.closest('.fr-bg-dropdown');
      if (dd) dd.classList.remove('open');
      this.render(true);
      if (game.user.isGM) {
        await saveState(state);
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
      
      // Get faction's min/max settings
      const state = getState();
      const page = state.pages.find(p => p.id === state.activePageId);
      if (!page) return;
      
      const faction = page.factions.find(f => f.id === fid);
      const minValue = faction?.minValue ?? -50;
      const maxValue = faction?.maxValue ?? 50;
      
      let v = Number(input.value) || 0;
      v = Math.max(minValue, Math.min(maxValue, Math.round(v)));
      log('info', 'Faction value changed', { factionId: fid, userId: uid, value: v });
      
      page.userRelations ||= {};
      page.userRelations[uid] ||= {};
      page.userRelations[uid][fid] = v;
      resetAnnouncementDismissalsForPage(page);
      
      // Check and send chat messages for triggered announcements (only for this faction)
      checkAndSendAnnouncementChatMessages(page, uid, fid);
      
      await saveState(state);
      // Fetch latest state and use for next render
      const latestState = getState();
      window._fr_temp_state = latestState;
      if (game.user.isGM && game.socket) {
        console.log('[FactionTracker] socket emit (numeric change)', latestState);
        game.socket.emit('module.bag-of-lists', latestState, {broadcast: true});
      }
      this.render(true);
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
    // Only allow drag and drop for GM
    const isGM = !!game.user.isGM;
    if (!isGM) return;
    
    const draggableSelector = '.fr-drag-handle';
    const $draggables = $html.find(draggableSelector);
    if ($draggables.length === 0) return;

    // Clean up any existing drag event handlers
    $draggables.off('mousedown.drag-reorder');
    
    // Drag state
    let drag = null;

    // Create a ghost element that follows the cursor
    const createGhost = (row) => {
      const name = row.querySelector('.fr-name')?.textContent || 'Item';
      const img = row.querySelector('.fr-img')?.src || 'icons/svg/shield.svg';
      
      const ghost = document.createElement('div');
      ghost.className = 'fr-drag-ghost';
      ghost.style.cssText = 'position:fixed; pointer-events:none; z-index:9999;';
      ghost.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px; padding:8px 12px; background:#23232b; border:2px solid #b48e5a; border-radius:6px; box-shadow:0 4px 12px rgba(0,0,0,0.5);">
          <img src="${img}" style="width:28px; height:28px; border-radius:4px; object-fit:cover;" />
          <span style="color:#fff; font-weight:600;">${name}</span>
        </div>
      `;
      document.body.appendChild(ghost);
      return ghost;
    };

    // Create a placeholder indicator (thin line)
    const createPlaceholder = () => {
      const tr = document.createElement('tr');
      tr.className = 'fr-drop-placeholder';
      tr.innerHTML = '<td colspan="999"><div style="height:3px; background:#b48e5a; margin:2px 0; border-radius:2px;"></div></td>';
      return tr;
    };

    // Get visible rows only (excluding placeholder AND hidden row)
    const getVisibleRows = () => {
      if (!drag?.tbody) return [];
      return Array.from(drag.tbody.querySelectorAll('tr:not(.fr-drop-placeholder):not(.fr-drag-hidden)'));
    };

    // Determine drop position based on mouse Y
    // Returns the INSERT INDEX - where to splice in the array AFTER removing the dragged item
    const getTargetIndex = (mouseY) => {
      const visibleRows = getVisibleRows();
      
      if (visibleRows.length === 0) return 0;
      
      // Find where cursor is among visible rows
      // visualInsertPos: 0 = before first visible, 1 = after first, etc.
      let visualInsertPos = 0;
      for (let i = 0; i < visibleRows.length; i++) {
        const rect = visibleRows[i].getBoundingClientRect();
        const midpoint = rect.top + rect.height / 2;
        
        if (mouseY >= midpoint) {
          visualInsertPos = i + 1;
        } else {
          break;
        }
      }
      
      // The visualInsertPos is the position in the visible (shortened) array
      // This is exactly the index we need to splice into after removing the dragged item
      return visualInsertPos;
    };

    // Position the placeholder in the DOM to show where drop will occur
    const positionPlaceholder = (insertIndex) => {
      if (insertIndex === drag.lastTargetIndex) return;
      
      const { placeholder, tbody } = drag;
      const visibleRows = getVisibleRows();
      
      // Remove from current position
      placeholder.remove();
      
      // Insert placeholder at the visual position
      // insertIndex 0 = before first visible row
      // insertIndex N = after Nth visible row (before N+1th, or at end)
      if (insertIndex >= visibleRows.length) {
        tbody.appendChild(placeholder);
      } else {
        tbody.insertBefore(placeholder, visibleRows[insertIndex]);
      }
      
      drag.lastTargetIndex = insertIndex;
    };

    // Handle mouse movement during drag
    const onMouseMove = (e) => {
      if (!drag) return;
      
      // Move ghost with cursor
      drag.ghost.style.left = `${e.clientX + 15}px`;
      drag.ghost.style.top = `${e.clientY - 10}px`;
      
      // Update placeholder position
      const targetIndex = getTargetIndex(e.clientY);
      positionPlaceholder(targetIndex);
    };

    // Handle mouse release - complete the drag
    const onMouseUp = () => {
      if (!drag) return;
      
      const { ghost, placeholder, tbody, draggedRow, originalIndex, factionId, lastTargetIndex } = drag;
      
      // Clean up DOM
      ghost.remove();
      placeholder.remove();
      tbody.classList.remove('fr-drop-zone');
      draggedRow.classList.remove('fr-drag-hidden');
      document.body.style.userSelect = '';
      
      // Remove listeners
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      
      // The lastTargetIndex is already the correct final position
      const finalIndex = lastTargetIndex;
      
      // Clear state
      this._isDragging = false;
      drag = null;
      
      // Reorder if position changed
      if (finalIndex !== originalIndex && factionId) {
        this._reorderFactions(factionId, originalIndex, finalIndex);
      }
    };

    // Start drag on mousedown
    $draggables.on('mousedown.drag-reorder', (e) => {
      if (e.button !== 0) return; // Left click only
      if (!e.target.closest('.fr-drag-handle')) return;
      if (this._isDragging) return;
      
      e.preventDefault();
      
      const row = e.currentTarget.closest('tr');
      const tbody = row?.parentNode;
      const factionId = row?.dataset?.fid;
      
      if (!row || !tbody || !factionId) return;
      
      // Get the original index
      const allRows = Array.from(tbody.querySelectorAll('tr'));
      const originalIndex = allRows.indexOf(row);
      if (originalIndex === -1) return;
      
      this._isDragging = true;
      
      // Create visual elements
      const ghost = createGhost(row);
      const placeholder = createPlaceholder();
      
      // Position ghost at cursor
      ghost.style.left = `${e.clientX + 15}px`;
      ghost.style.top = `${e.clientY - 10}px`;
      
      // Hide original row and mark container
      row.classList.add('fr-drag-hidden');
      tbody.classList.add('fr-drop-zone');
      
      // Insert placeholder at original position
      tbody.insertBefore(placeholder, row);
      
      // Initialize drag state
      drag = {
        ghost,
        placeholder,
        tbody,
        draggedRow: row,
        originalIndex,
        factionId,
        lastTargetIndex: originalIndex
      };
      
      // Prevent text selection
      document.body.style.userSelect = 'none';
      
      // Listen for drag events
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  /**
   * Reorder factions in the data and persist changes
   * @param {string} factionId - ID of faction being moved
   * @param {number} fromIndex - Original index in array
   * @param {number} toIndex - Insert position in the shortened array (after removal)
   */
  async _reorderFactions(factionId, fromIndex, toIndex) {
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

      // Validate indices
      if (fromIndex < 0 || fromIndex >= page.factions.length) {
        console.warn('[FactionTracker] Invalid fromIndex:', fromIndex);
        return;
      }

      // Remove item from original position
      const [faction] = page.factions.splice(fromIndex, 1);
      
      // toIndex is already the correct insert position for the shortened array
      // Clamp to valid range
      const insertAt = Math.max(0, Math.min(toIndex, page.factions.length));
      
      page.factions.splice(insertAt, 0, faction);
      
      // Save state and sync
      await saveState(state);
      
      // Update temp state and re-render
      const latestState = getState();
      window._fr_temp_state = latestState;
      this.render(true);
      
      log('info', 'Faction reordered', { 
        factionId, 
        name: faction.name,
        from: fromIndex, 
        insertAt 
      });
      
    } catch (error) {
      logError('Failed to reorder factions', error);
      ui.notifications?.error('Failed to reorder factions. Please try again.');
    }
  }
}

/** ------- Make the app available and add Scene Controls tool ------- **/
Hooks.once("ready", () => {
  // If socketlib.ready hasn't fired yet, initialize temp state now
  if (typeof window._fr_temp_state === 'undefined' || window._fr_temp_state === null) {
    window._fr_temp_state = getState();
  }
  
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
      if (!group.tools || typeof group.tools !== 'object') {
        group.tools = {};
      }
      group.tools["faction-tracker"] = {
        name: "faction-tracker",
        title: "Bag o' Lists",
        icon: "bol-toolbar-icon",
        order: Object.keys(group.tools).length,
        button: true,
        visible: true,
        onChange: (event, active) => {
          game.factionRelations?.openTracker?.();
        }
      };
    }
  } catch (err) {
    console.error(`[bag-of-lists] Scene Controls error:`, err);
  }
});

// Workaround for V13.350+ where onChange callback doesn't fire for button-type scene control tools
// Manually attach click handler after controls are rendered
Hooks.on("renderSceneControls", (controls, html) => {
  try {
    const element = html instanceof jQuery ? html[0] : (html?.element || html);
    const ourButton = element?.querySelector?.('[data-tool="faction-tracker"]');
    if (ourButton) {
      ourButton.removeEventListener('click', handleButtonClick);
      ourButton.addEventListener('click', handleButtonClick);
    }
  } catch (err) {
    console.error('[bag-of-lists] Error in renderSceneControls:', err);
  }
});

function handleButtonClick(event) {
  console.log('[bag-of-lists] Button clicked via DOM event handler!');
  event.preventDefault();
  event.stopPropagation();
  game.factionRelations?.openTracker?.();
}

