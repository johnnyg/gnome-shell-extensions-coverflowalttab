const Lang = imports.lang;
const Mainloop = imports.mainloop;

const Clutter = imports.gi.Clutter;
const St = imports.gi.St;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;

const AltTab = imports.ui.altTab;
const Main = imports.ui.main;
const Tweener = imports.ui.tweener;

/**
 * A preview for the selected window.
 */
function WindowPreview(win, switcher) {
	this._init(win, switcher);
}

WindowPreview.prototype = {
	_init: function(win, switcher) {
		this._switcher = switcher;

		this.actor = new St.Bin();
		this.actor.opacity = 0;

		let compositor = win.get_compositor_private();
		if (compositor) {
			let texture = compositor.get_texture();
			let [width, height] = texture.get_size();

			let clone = new Clutter.Clone({
				source: texture,
				reactive: false,
				width: width * 0.85,
				height: height * 0.85
			});
			this.actor.set_child(clone);
		}
	},

	show: function() {
		Main.uiGroup.add_actor(this.actor);
		this._switcher.actor.raise_top();

		let monitor = Main.layoutManager.primaryMonitor;
		this.actor.set_position(
			monitor.width / 2 - this.actor.width / 2,
			monitor.height / 2 - this.actor.height / 2
		);

		Tweener.addTween(this.actor, {
			opacity: 255,
			time: 0.25,
			transition: 'easeOutQuad'
		});
	},

	hide: function() {
		Tweener.addTween(this.actor, {
			opacity: 0,
			time: 0.25,
			transition: 'easeOutQuad',
			onComplete: Lang.bind(Main.uiGroup, Main.uiGroup.remove_actor, this.actor)
		});
	},
}

/**
 * The switcher
 */
function Switcher(list, thumbnails, actions) {
	this._init(list, thumbnails, actions);
}

Switcher.prototype = {
	_init: function(list, thumbnails, actions) {
		this.actor = new Shell.GenericContainer({
			name: 'altTabInvisiblePopup',
			reactive: true,
			visible: false,
		});

		this.actor.connect('get-preferred-width', Lang.bind(this, this._getPreferredWidth));
		this.actor.connect('get-preferred-height', Lang.bind(this, this._getPreferredHeight));
		this.actor.connect('allocate', Lang.bind(this, this._allocate));
		this.actor.connect('destroy', Lang.bind(this, this._onDestroy));

		this._list = list;
		this._thumbnails = thumbnails;
		this._modifierMask = null;
		this._currentIndex = 0;
		this._actions = actions;
		this._haveModal = false;
		this._preview = null;

		Main.uiGroup.add_actor(this.actor);
	},

	_getPreferredWidth: function(actor, forHeight, alloc) {
		alloc.min_size = global.screen_width;
		alloc.natural_size = global.screen_width;
	},

	_getPreferredHeight: function(actor, forWidth, alloc) {
		alloc.min_size = global.screen_height;
		alloc.natural_size = global.screen_height;
	},

	_allocate: function(actor, box, flags) {
		if (this._thumbnails) {
			let childBox = new Clutter.ActorBox();
			let primary = Main.layoutManager.primaryMonitor;

			let leftPadding = this.actor.get_theme_node().get_padding(St.Side.LEFT);
			let rightPadding = this.actor.get_theme_node().get_padding(St.Side.RIGHT);
			let bottomPadding = this.actor.get_theme_node().get_padding(St.Side.BOTTOM);
			let vPadding = this.actor.get_theme_node().get_vertical_padding();
			let hPadding = leftPadding + rightPadding;

			let [childMinHeight, childNaturalHeight] = this._thumbnails.actor.get_preferred_height(primary.width - hPadding);
			let [childMinWidth, childNaturalWidth] = this._thumbnails.actor.get_preferred_width(childNaturalHeight);
			childBox.x1 = Math.max(primary.x + leftPadding, primary.x + Math.floor((primary.width - childNaturalWidth) / 2));
			childBox.x2 = Math.min(primary.x + primary.width - rightPadding, childBox.x1 + childNaturalWidth);
			childBox.y1 = primary.y + primary.height - childNaturalHeight - Math.max(20, bottomPadding + vPadding);
			this._thumbnails.addClones(primary.height);
			childBox.y2 = childBox.y1 + childNaturalHeight;
			this._thumbnails.actor.allocate(childBox, flags);
		}
	},

	show: function(shellwm, binding, mask, window, backwords) {
		if (!Main.pushModal(this.actor)) {
			return false;
		}

		this._haveModal = true;
		this._modifierMask = AltTab.primaryModifier(mask);

		this.actor.connect('key-press-event', Lang.bind(this, this._keyPressEvent));
		this.actor.connect('key-release-event', Lang.bind(this, this._keyReleaseEvent));

		this.actor.add_actor(this._thumbnails.actor);
		this._thumbnails.actor.get_allocation_box();

		// need to force an allocation so we can figure out whether we
		// need to scroll when selecting
		this.actor.opacity = 0;
		this.actor.show();
		this.actor.get_allocation_box();

		this._next();
		this._createPreview();

		// There's a race condition; if the user released Alt before
		// we gotthe grab, then we won't be notified. (See
		// https://bugzilla.gnome.org/show_bug.cgi?id=596695 for
		// details) So we check now. (Have to do this after updating
		// selection.)
		let [x, y, mods] = global.get_pointer();
		if (!(mods & this._modifierMask)) {
			this._activateSelected();

			return false;
		}

		Tweener.addTween(this.actor, {
			opacity: 255,
			time: 0.25,
			transition: 'easeOutQuad'
		});

		return true;
	},

	_next: function() {
		this._currentIndex = (this._currentIndex + 1) % this._list.length;
		this._thumbnails.highlight(this._currentIndex, true);
	},

	_previous: function() {
		this._currentIndex = (this._currentIndex + this._list.length - 1) % this._list.length;
		this._thumbnails.highlight(this._currentIndex, true);
	},

	_createPreview: function() {
		if (this._preview) {
			this._preview.hide();
		}
		this._preview = new WindowPreview(this._list[this._currentIndex], this);
		this._preview.show();
	},

	_removePreview: function() {
		if (this._preview) {
			this._preview.hide();
			this._preview = null;
		}
	},

	_keyPressEvent: function(actor, event) {
		let keysym = event.get_key_symbol();
		let event_state = Shell.get_event_state(event);

		let backwards = event_state & Clutter.ModifierType.SHIFT_MASK;
		let action = global.display.get_keybinding_action(event.get_key_code(), event_state);

		if (keysym == Clutter.Escape) {
			this.destroy();
		} else if (keysym == Clutter.q || keysym == Clutter.Q) {
			this._actions['remove_selected'](this._list[this._currentIndex]);
			this.destroy();
		} else if (action == Meta.KeyBindingAction.SWITCH_GROUP ||
				   action == Meta.KeyBindingAction.SWITCH_WINDOWS) {
			backwards ? this._previous() : this._next();
		} else if (action == Meta.KeyBindingAction.SWITCH_GROUP_BACKWORD ||
				   action == Meta.KeyBindingAction.SWITCH_WINDOWS_BACKWORD) {
			this._previous();
		}

		// remove old preview then create a new one.
		this._removePreview();
		this._createPreview();

		return true;
	},

	_keyReleaseEvent: function(actor, event) {
		let [x, y, mods] = global.get_pointer();
		let state = mods & this._modifierMask;

		if (state == 0) {
			this._activateSelected();
		}

		return true;
	},

	_activateSelected: function() {
		global.log(this._currentIndex);
		this._actions['activate_selected'](this._list[this._currentIndex]);
		this.destroy();
	},

	_onDestroy: function() {
		this._removePreview();

		Tweener.removeTweens(this.actor);
		Tweener.addTween(this.actor, {
			opacity: 0,
			time: 0.25,
			transition: 'easeOutQuad',
			onComplete: Lang.bind(Main.uiGroup, Main.uiGroup.remove_actor, this.actor)
		});

		if (this._haveModal) {
			Main.popModal(this.actor);
			this._haveModal = false;
		}

		this._list = null;
		this._thumbnails = null;
	},

	destroy: function() {
		this._onDestroy();
	},
}

/**
 * This class handles window events, so we can keep a stack of windows ordered
 * by the most recently focused window.
 */
function Manager() {
	this._init();
}

Manager.prototype = {
	_init: function() {
	},

	_activateSelectedWindow: function(win) {
		Main.activateWindow(win);
	},

	_removeSelectedWindow: function(win) {
		win.delete(global.get_current_time());
	},

	_startWindowSwitcher: function (shellwm, binding, mask, window, backwords) {
		let windows = [];
		let thumbnails = null;
		let actions = {};
		let currentWorkspace = global.screen.get_active_workspace();
		let currentIndex = 0;

		// construct a list with all windows
		let windowActors = global.get_window_actors();
		for (let i in windowActors) {
			windows.push(windowActors[i].get_meta_window());
		}
		windowActors = null;
		if (binding == 'switch_group') {
			windows = windows.filter(
				function(win) {
					return win.get_workspace() == currentWorkspace && !win.is_skip_taskbar();
				}
			);
		}
		windows.sort(Lang.bind(this,
			function(win1, win2) {
				let t1 = win1.get_user_time();
				let t2 = win2.get_user_time();

				return (t2 > t1) ? 1 : -1 ;
			}
		));

		// generate thumbnails
		thumbnails = new AltTab.ThumbnailList(windows);
		if (thumbnails._separator) {
			thumbnails._list.remove_actor(thumbnails._separator);
			thumbnails._separator = null;
		}
		actions['activate_selected'] = this._activateSelectedWindow;
		actions['remove_selected'] = this._removeSelectedWindow;

		if (!global.display.focus_window) {
			currentIndex = -1;
		}

		if (windows.length) {
			let switcher = new Switcher(windows, thumbnails, actions);
			switcher._currentIndex = currentIndex;

			if (!switcher.show(shellwm, binding, mask, window, backwords)) {
				switcher.destroy();
			}
		}
	},
}

// extension specific functions
let manager = null;

function init() {
}

function enable() {
    if (!manager) {
        manager = new Manager();
    }

    Main.wm.setKeybindingHandler('switch_windows', Lang.bind(manager, manager._startWindowSwitcher));
    Main.wm.setKeybindingHandler('switch_group', Lang.bind(manager, manager._startWindowSwitcher));
    Main.wm.setKeybindingHandler('switch_windows_backward', Lang.bind(manager, manager._startWindowSwitcher));
    Main.wm.setKeybindingHandler('switch_group_backward', Lang.bind(manager, manager._startWindowSwitcher));
}

function disable() {
	if (manager) {
		manager = null;
	}

    Main.wm.setKeybindingHandler('switch_windows', Lang.bind(Main.wm, Main.wm._startAppSwitcher));
    Main.wm.setKeybindingHandler('switch_group', Lang.bind(Main.wm, Main.wm._startAppSwitcher));
    Main.wm.setKeybindingHandler('switch_windows_backward', Lang.bind(Main.wm, Main.wm._startAppSwitcher));
    Main.wm.setKeybindingHandler('switch_group_backward', Lang.bind(Main.wm, Main.wm._startAppSwitcher));
}
