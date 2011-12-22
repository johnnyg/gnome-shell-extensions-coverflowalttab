const Lang = imports.lang;
const Mainloop = imports.mainloop;

const Clutter = imports.gi.Clutter;
const St = imports.gi.St;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;

const AltTab = imports.ui.altTab;
const Main = imports.ui.main;
const Tweener = imports.ui.tweener;

let level = 0;

/**
 * The switcher
 */
let WINDOWPREVIEW_SCALE = 0.5;

function Switcher(windows, actions) {
	this._init(windows, actions);
}

Switcher.prototype = {
	_init: function(windows, actions) {
		this._windows = windows;
		this._windowTitle = null;
		this._modifierMask = null;
		this._currentIndex = 0;
		this._actions = actions;
		this._haveModal = false;

		let monitor = Main.layoutManager.primaryMonitor;
		this.actor = new St.Group({
			style_class: 'coverflow-switcher',
			visible: true,
			x: 0,
			y: 0,
			width: monitor.width,
			height: monitor.height,
		});

		this.actor.add_actor(new St.Bin({
			style_class: 'coverflow-switcher-gradient',
			visible: true,
			x: 0,
			y: monitor.height / 2,
			width: monitor.width,
			height: monitor.height / 2,
		}));

		// create previews
		this._previews = [];
		for (let i in windows) {
			let compositor = windows[i].get_compositor_private();
			if (compositor) {
				let texture = compositor = compositor.get_texture();
				let [width, height] = texture.get_size();

				let scale = 1.0;
				if (width > monitor.width * WINDOWPREVIEW_SCALE ||
					height > monitor.height * WINDOWPREVIEW_SCALE) {
					scale = Math.min(monitor.width * WINDOWPREVIEW_SCALE / width, monitor.height * WINDOWPREVIEW_SCALE / height);
				}

				let clone = new Clutter.Clone({
					source: texture,
					reactive: false,
					rotation_center_y: new Clutter.Vertex({ x: width * scale / 2, y: 0.0, z: 0.0 }),
					width: width * scale,
					height: height * scale,
					x: (monitor.width - (width * scale)) / 2,
					y: (monitor.height - (height * scale)) / 2,
				});

				this._previews.push(clone);
				this.actor.add_actor(clone);
			}
		}

		Main.uiGroup.add_actor(this.actor);
	},

	show: function(shellwm, binding, mask, window, backwords) {
		if (!Main.pushModal(this.actor)) {
			return false;
		}

		this._haveModal = true;
		this._modifierMask = AltTab.primaryModifier(mask);

		this.actor.connect('key-press-event', Lang.bind(this, this._keyPressEvent));
		this.actor.connect('key-release-event', Lang.bind(this, this._keyReleaseEvent));

		this.actor.opacity = 0;
		this.actor.show();

		this._next();

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
		this._currentIndex = (this._currentIndex + 1) % this._windows.length;
		this._updateCoverflow();
	},

	_previous: function() {
		this._currentIndex = (this._currentIndex + this._windows.length - 1) % this._windows.length;
		this._updateCoverflow();
	},

	_updateCoverflow: function() {
		let monitor = Main.layoutManager.primaryMonitor;

		// window title label
		if (this._windowTitle) {
			Tweener.addTween(this._windowTitle, {
				opacity: 0,
				time: 0.25,
				transition: 'easeOutQuad',
				onComplete: Lang.bind(this.actor, this.actor.remove_actor, this._windowTitle),
			});
		}

		this._windowTitle = new St.Label({
			style_class: 'modal-dialog',
			text: this._windows[this._currentIndex].get_title(),
			opacity: 0,
		});
		this._windowTitle.add_style_class_name('run-dialog');
		this._windowTitle.add_style_class_name('coverflow-window-title-label');
		this.actor.add_actor(this._windowTitle);
		this._windowTitle.x = (monitor.width - this._windowTitle.width) / 2;
		this._windowTitle.y = monitor.height - this._windowTitle.height - 20;
		Tweener.addTween(this._windowTitle, {
			opacity: 255,
			time: 0.25,
			transition: 'easeOutQuad',
		});

		// preview windows
		for (let i in this._previews) {
			let preview = this._previews[i];
			let [width, height] = preview.get_size();

			if (i == this._currentIndex) {
				preview.raise_top();

				Tweener.addTween(preview, {
					x: (monitor.width - width) / 2,
					y: (monitor.height - height) / 2,
					rotation_angle_y: 0.0,
					time: 0.25,
					transition: 'easeOutQuad',
				});
			} else if (i < this._currentIndex) {
				Tweener.addTween(preview, {
					x: monitor.width * 0.20 - width / 2 + 25 * (i - this._currentIndex),
					y: (monitor.height - height) / 2,
					rotation_angle_y: 60.0,
					time: 0.25,
					transition: 'easeOutQuad',
				});
			} else if (i > this._currentIndex) {
				Tweener.addTween(preview, {
					x: monitor.width * 0.80 - width / 2 + 25 * (i - this._currentIndex),
					y: (monitor.height - height) / 2,
					rotation_angle_y: -60.0,
					time: 0.25,
					transition: 'easeOutQuad',
				});
			}
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
			this._actions['remove_selected'](this._windows[this._currentIndex]);
			this.destroy();
		} else if (action == Meta.KeyBindingAction.SWITCH_GROUP ||
				   action == Meta.KeyBindingAction.SWITCH_WINDOWS ||
				   action == Meta.KeyBindingAction.SWITCH_PANELS) {
			backwards ? this._previous() : this._next();
		} else if (action == Meta.KeyBindingAction.SWITCH_GROUP_BACKWORD ||
				   action == Meta.KeyBindingAction.SWITCH_WINDOWS_BACKWORD) {
			this._previous();
		}

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
		this._actions['activate_selected'](this._windows[this._currentIndex]);
		this.destroy();
	},

	_onDestroy: function() {
		let monitor = Main.layoutManager.primaryMonitor;

		// preview windows
		for (let i in this._previews) {
			let preview = this._previews[i];
			let [width, height] = preview.get_size();

			Tweener.addTween(preview, {
				x: (monitor.width - width) / 2,
				y: (monitor.height - height) / 2,
				rotation_angle_y: 0.0,
				time: 0.25,
				transition: 'easeOutQuad',
			});
		}
		// selected preview window
		let compositor = this._windows[this._currentIndex].get_compositor_private();
		if (compositor) {
			Tweener.removeTweens(this._previews[this._currentIndex]);
			Tweener.addTween(this._previews[this._currentIndex], {
				x: compositor.x,
				y: compositor.y,
				width: compositor.width,
				height: compositor.height,
				time: 0.25,
				transition: 'easeOutQuad',
			});
		}

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

		this._windows = null;
		this._previews = null;
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
		let actions = {};
		let currentWorkspace = global.screen.get_active_workspace();
		let currentIndex = 0;

		// construct a list with all windows
		let windowActors = global.get_window_actors();
		for (let i in windowActors) {
			windows.push(windowActors[i].get_meta_window());
		}
		windowActors = null;
		windows.sort(Lang.bind(this,
			function(win1, win2) {
				let t1 = win1.get_user_time();
				let t2 = win2.get_user_time();

				return (t2 > t1) ? 1 : -1 ;
			}
		));

		// filter by modes
		if (binding == 'switch_group') {
			windows = windows.filter(
				function(win) {
					return win.get_workspace() == currentWorkspace && !win.is_skip_taskbar();
				}
			);
		} else if (binding == 'switch_panels') {
			let focused = global.display.focus_window;
			if (!focused)
				focused = windows[0];

			windows = windows.filter(
				function(win) {
					return win.get_wm_class() == focused.get_wm_class() && !win.is_skip_taskbar();
				}
			);
		}
		// else { // does nothing }

		if (windows.length) {
			actions['activate_selected'] = this._activateSelectedWindow;
			actions['remove_selected'] = this._removeSelectedWindow;

			if (!global.display.focus_window) {
				currentIndex = -1;
			}

			let switcher = new Switcher(windows, actions);
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
	Main.wm.setKeybindingHandler('switch_panels', Lang.bind(manager, manager._startWindowSwitcher));
	Main.wm.setKeybindingHandler('switch_windows_backward', Lang.bind(manager, manager._startWindowSwitcher));
	Main.wm.setKeybindingHandler('switch_group_backward', Lang.bind(manager, manager._startWindowSwitcher));
}

function disable() {
	if (manager) {
		manager = null;
	}

	Main.wm.setKeybindingHandler('switch_windows', Lang.bind(Main.wm, Main.wm._startAppSwitcher));
	Main.wm.setKeybindingHandler('switch_group', Lang.bind(Main.wm, Main.wm._startAppSwitcher));
	Main.wm.setKeybindingHandler('switch_panels', Lang.bind(Main.wm, Main.wm._startA11ySwitcher));
	Main.wm.setKeybindingHandler('switch_windows_backward', Lang.bind(Main.wm, Main.wm._startAppSwitcher));
	Main.wm.setKeybindingHandler('switch_group_backward', Lang.bind(Main.wm, Main.wm._startAppSwitcher));
}
