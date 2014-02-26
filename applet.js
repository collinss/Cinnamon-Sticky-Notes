const Cinnamon = imports.gi.Cinnamon;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Meta = imports.gi.Meta;
const Pango = imports.gi.Pango;
const St = imports.gi.St;

const Applet = imports.ui.applet;
const DND = imports.ui.dnd;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Tooltips = imports.ui.tooltips;
const Tweener = imports.ui.tweener;

const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Signals = imports.signals;

const STICKY_DRAG_INTERVAL = 25;
const DESTROY_TIME = 0.5;
const START_HEIGHT = 200;
const START_WIDTH = 200;
const PADDING = 10;


let topBox, bottomBox;
let mouseTrackEnabled;
let notesRaised;


let settings;
function SettingsManager(uuid, instanceId) {
    this._init(uuid, instanceId);
}

SettingsManager.prototype = {
    _init: function(uuid, instanceId) {
        try {
            
            this.settings = new Settings.AppletSettings(this, uuid, instanceId);
            this.settings.bindProperty(Settings.BindingDirection.BIDIRECTIONAL, "storedNotes", "storedNotes");
            this.settings.bindProperty(Settings.BindingDirection.BIDIRECTIONAL, "hideState", "hideState");
            this.settings.bindProperty(Settings.BindingDirection.BIDIRECTIONAL, "collapsed", "collapsed", function() { this.emit("collapsed-changed"); });
            this.settings.bindProperty(Settings.BindingDirection.IN, "theme", "theme", function() { this.emit("theme-changed"); });
            this.settings.bindProperty(Settings.BindingDirection.IN, "startState", "startState");
            
        } catch(e) {
            global.logError(e);
        }
    },
    
    saveNotes:function(notes) {
        this.storedNotes = notes;
    }
}
Signals.addSignalMethods(SettingsManager.prototype);


function PanelButton(parent, iconPath, tooltipText, command) {
    this._init(parent, iconPath, tooltipText, command);
}

PanelButton.prototype = {
    _init: function(parent, iconPath, tooltipText, command) {
        this.parent = parent;
        this.command = command;
        
        this.actor = new St.Button({ style_class: "sticky-panelButton" });
        
        let file = Gio.file_new_for_path(iconPath);
        let gicon = new Gio.FileIcon({ file: file });
        let icon = new St.Icon({ gicon: gicon, icon_size: 16, icon_type: St.IconType.SYMBOLIC });
        this.actor.add_actor(icon);
        
        this.actor.connect("clicked", Lang.bind(this, this.activate));
        
        let tooltip = new Tooltips.Tooltip(this.actor, tooltipText)
    },
    
    activate: function() {
        if ( this.parent.menu ) this.parent.menu.close();
        this.command();
    }
}


function Note(info) {
    this._init(info);
}

Note.prototype = {
    _init: function(info) {
        try {
            
            this._dragging = false;
            this._dragOffset = [0, 0];
            
            this.actor = new St.BoxLayout({ vertical: true, reactive: true, track_hover: true, style_class: settings.theme + "-noteBox", height: START_HEIGHT, width: START_WIDTH });
            this.actor._delegate = this;
            
            this.scrollBox = new St.ScrollView({ style_class: settings.theme + "-scrollBox" });
            this.actor.add_actor(this.scrollBox);
            this.scrollBox.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);
            
            this.textContainer = new St.BoxLayout();
            this.scrollBox.add_actor(this.textContainer);
            
            this.textBox = new St.Entry({  });
            this.textContainer.add_actor(this.textBox);
            if ( info ) this.textBox.text = info.text;
            
            this.text = this.textBox.clutter_text;
            this.text.set_single_line_mode(false);
            this.text.set_activatable(false);
            this.text.ellipsize = Pango.EllipsizeMode.NONE;
            this.text.line_wrap = true;
            this.text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
            this.text.set_selectable(true);
            
            this.actor.connect("motion-event", Lang.bind(this, this.updateDnD));
            this.text.connect("button-release-event", Lang.bind(this, this.onButtonRelease));
            this.text.connect("button-press-event", Lang.bind(this, this.onButtonPress));
            this.text.connect("text-changed", Lang.bind(this, function() { this.emit("changed"); }));
            this.text.connect("cursor-event", Lang.bind(this, this.handleScrollPosition));
            this.text.connect("key-focus-in", Lang.bind(this, this.onTextFocused));
            this.actor.connect("button-release-event", Lang.bind(this, this.onButtonRelease));
            this.actor.connect("button-press-event", Lang.bind(this, this.onButtonPress));
            settings.connect("theme-changed", Lang.bind(this, function() {
                this.actor.style_class = settings.theme + "-noteBox";
            }));
            
            let padding = new St.Bin({ reactive: true });
            this.actor.add(padding, { y_expand: true, y_fill: true, x_expand: true, x_fill: true });
            
            this.menuManager = new PopupMenu.PopupMenuManager(this);
            this.menu = new PopupMenu.PopupMenu(this.actor, 0.0, St.Side.LEFT, 0);
            this.menuManager.addMenu(this.menu);
            Main.uiGroup.add_actor(this.menu.actor);
            this.menu.actor.hide();
            
            this.buildMenu();
            
        } catch(e) {
            global.logError(e);
        }
    },
    
    test: function() {
        global.log(!Main.uiGroup.get_skip_paint(this.actor));
        Mainloop.timeout_add_seconds(2, Lang.bind(this, this.test));
    },
    
    buildMenu: function() {
        let remove = new PopupMenu.PopupMenuItem("Remove");
        this.menu.addMenuItem(remove);
        remove.connect("activate", Lang.bind(this, function() {
            this.emit("destroy", this);
        }));
        
        let copy = new PopupMenu.PopupMenuItem("Copy");
        this.menu.addMenuItem(copy);
        copy.connect("activate", Lang.bind(this, this.copy));
        
        let paste = new PopupMenu.PopupMenuItem("Paste");
        this.menu.addMenuItem(paste);
        paste.connect("activate", Lang.bind(this, this.paste));
    },
    
    _onDragBegin: function() {
        global.set_stage_input_mode(Cinnamon.StageInputMode.FULLSCREEN);
    },
    
    _onDragEnd: function() {
        this.updateDnD();
        global.set_stage_input_mode(Cinnamon.StageInputMode.NORMAL);
        this.trackMouse();
    },
    
    updateDnD: function() {
        if ( this.text.has_pointer ) this.draggable.inhibit = true;
        else this.draggable.inhibit = false;
    },
    
    destroy: function(){
        Tweener.addTween(this.actor, {
            opacity: 0,
            transition: "linear",
            time: DESTROY_TIME,
            onComplete: Lang.bind(this, function() {
                this.actor.destroy();
            })
        });
        this.menu.destroy();
        
        this.menu = null;
        this.menuManager = null;
    },
    
    onButtonRelease: function(actor, event) {
        if ( event.get_button() == 3 ) return true;
        
        if ( this.pointerGrabbed ) {
            global.set_stage_input_mode(Cinnamon.StageInputMode.FOCUSED);
            Clutter.ungrab_pointer();
            this.pointerGrabbed = false;
            return false;
        }
        
        if ( event.get_source() == this.text ) {
            if ( !notesRaised ) this.focusText();
        }
        else {
            this.focusText();
            this.text.cursor_position = this.text.selection_bound = this.text.text.length;
        }
        
        return false;
    },
    
    onButtonPress: function(actor, event) {
        if ( event.get_button() == 3 ) {
            this.menu.toggle();
            
            //make sure menu is positioned correctly
            let rightEdge;
            for ( let i = 0; i < Main.layoutManager.monitors.length; i++ ) {
                let monitor = Main.layoutManager.monitors[i];
                
                if ( monitor.x <= this.actor.x &&
                     monitor.y <= this.actor.y &&
                     monitor.x + monitor.width > this.actor.x &&
                     monitor.y + monitor.height > this.actor.y ) {
                    
                    rightEdge = monitor.x + monitor.width;
                    break;
                }
            }
            
            if ( this.actor.x + this.actor.width + this.menu.actor.width > rightEdge )
                this.menu.setArrowSide(St.Side.RIGHT);
            else this.menu.setArrowSide(St.Side.LEFT);
            
            return true;
        }
        
        if ( this.menu.isOpen ) this.menu.close();
        
        if ( actor == this.text ) {
            global.set_stage_input_mode(Cinnamon.StageInputMode.FULLSCREEN);
            Clutter.grab_pointer(this.text);
            this.pointerGrabbed = true;
        }
        
        return false;
    },
    
    handleScrollPosition: function(text, geometry) {
        let textHeight = this.textBox.height;
        let scrollHeight = this.scrollBox.height;
        
        if ( textHeight <= scrollHeight ) return;
        
        let adjustment = this.textContainer.vadjustment;
        let cursorY = geometry.y;
        let startY = adjustment.value;
        let endY = scrollHeight + startY;
        
        if ( cursorY < startY + geometry.height*2 ) {
            let desiredPosition = cursorY - geometry.height*2;
            adjustment.set_value(( desiredPosition > 0 ? desiredPosition : 0 ));
        }
        else if ( cursorY > endY - geometry.height*3 ) {
            let desiredPosition = cursorY + geometry.height*3;
            adjustment.set_value(( desiredPosition < textHeight ? desiredPosition : textHeight ) - scrollHeight);
        }
    },
    
    trackMouse: function() {
        if( !Main.layoutManager.isTrackingChrome(this.actor) ) {
            Main.layoutManager.addChrome(this.actor, { doNotAdd: true });
            this._isTracked = true;
        }
    },
    
    untrackMouse: function() {
        if( Main.layoutManager.isTrackingChrome(this.actor) ) {
            Main.layoutManager.untrackChrome(this.actor);
            this._isTracked = false;
        }
    },
    
    onTextFocused: function() {
        if ( !this.unfocusId ) this.unfocusId = this.text.connect("key-focus-out", Lang.bind(this, this.unfocusText));
        this.actor.add_style_pseudo_class("focus");
    },
    
    focusText: function() {
        let currentMode = global.stage_input_mode;
        if ( currentMode == Cinnamon.StageInputMode.FOCUSED && this.textBox.has_key_focus() ) return;
        this.previousMode = currentMode;
        if ( currentMode != Cinnamon.StageInputMode.FOCUSED ) {
            global.set_stage_input_mode(Cinnamon.StageInputMode.FOCUSED);
        }
        
        this.textBox.grab_key_focus();
    },
    
    unfocusText: function() {
        if ( this.unfocusId ) {
            this.text.disconnect(this.unfocusId);
            this.unfocusId = null;
        }
        if ( global.stage_input_mode == Cinnamon.StageInputMode.FOCUSED ) {
            if ( this.previousMode ) global.set_stage_input_mode(this.previousMode);
            else global.set_stage_input_mode(Cinnamon.StageInputMode.NORMAL);
        }
        this.previousMode = null;
        this.actor.remove_style_pseudo_class("focus");
    },
    
    getInfo: function() {
        return { text: this.textBox.text, x: this.actor.x, y: this.actor.y };
    },
    
    copy: function() {
        let cursor = this.text.get_cursor_position();
        let selection = this.text.get_selection_bound();
        let text;
        if ( cursor == selection ) text = this.text.get_text();
        else text = this.text.get_selection();
        St.Clipboard.get_default().set_text(text);
    },
    
    paste: function() {
        St.Clipboard.get_default().get_text(Lang.bind(this, function(cb, text) {
            let cursor = this.text.get_cursor_position();
            let selection = this.text.get_selection_bound();
            if ( cursor != selection ) this.text.delete_selection();
            this.text.insert_text(text, this.text.get_cursor_position());
        }));
    }
}
Signals.addSignalMethods(Note.prototype);


function NoteBox() {
    this._init();
}

NoteBox.prototype = {
    _init: function() {
        this.notes = [];
        this.last_x = -1;
        this.last_y = -1;
        this.mouseTrackEnabled = -1;
        
        this.actor = new Clutter.Group();
        this.actor._delegate = this;
        if ( settings.startState == 1 || ( settings.startState == 2 && settings.hideState ) ) {
            this.actor.hide();
            settings.hideState = true;
        }
        else if ( settings.startState == 0 ) settings.hideState = false;
        
        this.dragPlaceholder = new St.Bin({ style_class: "desklet-drag-placeholder" });
        this.dragPlaceholder.hide();
        
        bottomBox.add_actor(this.actor);
        this.enableMouseTracking(true);
        this.initializeNotes();
    },
    
    setNotes: function() {
        for ( let i = 0; i < this.storedNotes.length; i++ ) {
            this.addNote(this.storedNotes[i]);
        }
    },
    
    addNote: function(info) {
        let note = new Note(info);
        let x, y;
        if ( info ) {
            x = info.x;
            y = info.y;
        }
        else [x, y] = this.getAvailableCoordinates();
        this.notes.push(note);
        this.actor.add_actor(note.actor);
        note.actor.x = x;
        note.actor.y = y;
        
        note.connect("destroy", Lang.bind(this, this.removeNote));
        note.connect("changed", Lang.bind(this, this.update));
        note.actor.connect("motion-event", Lang.bind(this, this.checkMouseTracking));
        
        note.draggable = DND.makeDraggable(note.actor, { restoreOnSuccess: true }, this.actor);
        note.draggable.connect("drag-begin", Lang.bind(note, note._onDragBegin));
        note.draggable.connect("drag-end", Lang.bind(note, note._onDragEnd));
        note.draggable.connect("drag-cancelled", Lang.bind(note, note._onDragEnd));
        
        if ( this.mouseTrackEnabled ) note.trackMouse();
        else note.untrackMouse();
        
        return note;
    },
    
    newNote: function() {
        let note = this.addNote(null);
        this.update();
        this.raiseNotes();
        Mainloop.idle_add(Lang.bind(note, note.focusText));
    },
    
    removeNote: function(note) {
        for ( let i = 0; i < this.notes.length; i++ ) {
            if ( this.notes[i] == note ) {
                this.notes[i].destroy();
                this.notes.splice(i,1);
                break;
            }
        }
        this.update();
    },
    
    removeAll: function() {
        for ( let i = 0; i < this.notes.length; i++ ) {
            this.notes[i].destroy();
        }
        this.notes = [];
    },
    
    update: function() {
        let notesData = [];
        for ( let i = 0; i < this.notes.length; i++ )
            notesData.push(this.notes[i].getInfo());
        settings.saveNotes(notesData);
    },
    
    initializeNotes: function() {
        try {
            for ( let i = 0; i < settings.storedNotes.length; i++ ) {
                this.addNote(settings.storedNotes[i]);
            }
        } catch(e) {
            global.logError(e);
        }
    },
    
    raiseNotes: function() {
        try {
            if ( notesRaised ) return;
            global.reparentActor(this.actor, topBox);
            if ( settings.hideState ) {
                this.actor.show();
                settings.hideState = false;
            }
            
            notesRaised = true;
            this.checkMouseTracking();
            
            this.emit("state-changed");
        } catch(e) {
            global.logError(e);
        }
    },
    
    lowerNotes: function() {
        try {
            global.reparentActor(this.actor, bottomBox);
            if ( settings.hideState ) {
                this.actor.show();
                settings.hideState = false;
            }
            
            notesRaised = false;
            this.checkMouseTracking();
            
            this.emit("state-changed");
        } catch(e) {
            global.logError(e);
        }
    },
    
    hideNotes: function() {
        try {
            if ( settings.hideState ) return;
            this.actor.hide();
            settings.hideState = true;
            if ( this.stageEventIds ) {
                for ( let i = 0; i < this.stageEventIds.length; i++ ) global.stage.disconnect(this.stageEventIds[i]);
                this.stageEventIds = null;
            }
            this.emit("state-changed");
        } catch(e) {
            global.logError(e);
        }
    },
    
    handleDragOver: function(source, actor, x, y, time) {
        if ( !this.dragPlaceholder.get_parent() ) Main.uiGroup.add_actor(this.dragPlaceholder);
        
        this.dragPlaceholder.show();
        
        let interval = STICKY_DRAG_INTERVAL;
        if ( this.last_x == -1 && this.last_y == -1 ) {
            this.last_x = actor.get_x();
            this.last_y = actor.get_y();
        }
        
        let x_next = Math.abs(actor.get_x() - this.last_x) > interval / 2;
        let y_next = Math.abs(actor.get_y() - this.last_y) > interval / 2;
        
        if ( actor.get_x() < this.last_x ) {
            if ( x_next ) {
                x = Math.floor(actor.get_x()/interval) * interval;
            }
            else {
                x = Math.ceil(actor.get_x()/interval) * interval;
            }
        }
        else {
            if ( x_next ) {
                x = Math.ceil(actor.get_x()/interval) * interval;
            }
            else {
                x = Math.floor(actor.get_x()/interval) * interval;
            }
        }
        
        if ( actor.get_y() < this.last_y ) {
            if ( y_next ) {
                y = Math.floor(actor.get_y()/interval) * interval;
            }
            else {
                y = Math.ceil(actor.get_y()/interval) * interval;
            }
        }
        else {
            if ( y_next ) {
                y = Math.ceil(actor.get_y()/interval) * interval;
            }
            else {
                y = Math.floor(actor.get_y()/interval) * interval;
            }
        }
        
        this.dragPlaceholder.set_position(x,y);
        this.dragPlaceholder.set_size(actor.get_width(), actor.get_height());
        this.last_x = x;
        this.last_y = y;
        return DND.DragMotionResult.MOVE_DROP;
    },
    
    acceptDrop: function(source, actor, x, y, time) {
        if ( !(source instanceof Note) ) return false;
        
        Main.uiGroup.remove_actor(actor);
        this.actor.add_actor(actor);
        mouseTrackEnabled = false;
        this.checkMouseTracking();
        
        this.update();
        
        this.dragPlaceholder.hide();
        this.last_x = -1;
        this.last_y = -1;
        return true;
    },
    
    cancelDrag: function(source, actor) {
        if ( !(source instanceof Note) ) return false;
        
        Main.uiGroup.remove_actor(actor);
        this.actor.add_actor(actor);
        
        mouseTrackEnabled = -1;
        this.checkMouseTracking();
        
        this.dragPlaceholder.hide();
        
        this.last_x = -1;
        this.last_y = -1;
        
        return true;
    },
    
    checkMouseTracking: function() {
        let window = global.screen.get_mouse_window(null);
        
        let enable = !(window && window.window_type != Meta.WindowType.DESKTOP) || notesRaised;
        if ( this.mouseTrackEnabled != enable ) {
            this.mouseTrackEnabled = enable;
            if ( enable ) {
                for ( let i = 0; i < this.notes.length; i++ ) this.notes[i].trackMouse();
            }
            else {
                for ( let i = 0; i < this.notes.length; i++ ) this.notes[i].untrackMouse();
            }
        }
    },
    
    enableMouseTracking: function(enable) {
        if( enable && !this.mouseTrackTimoutId )
            this.mouseTrackTimoutId = Mainloop.timeout_add(500, Lang.bind(this, this.checkMouseTracking));
        else if ( !enable && this.mouseTrackTimoutId ) {
            Mainloop.source_remove(this.mouseTrackTimoutId);
            for ( let i = 0; i < this.notes.length; i++ ) {
                this.notes[i].untrackMouse();
            }
        }
    },
    
    getAvailableCoordinates: function() {
        //determine boundaries
        let monitor = Main.layoutManager.primaryMonitor;
        let startX = PADDING + monitor.x;
        let startY = PADDING + monitor.y;
        if ( Main.desktop_layout != Main.LAYOUT_TRADITIONAL ) startY += Main.panel.actor.height;
        let width = monitor.width - PADDING;
        let height = monitor.height - Main.panel.actor.height - PADDING;
        if ( Main.desktop_layout == Main.LAYOUT_CLASSIC ) height -= Main.panel2.actor.height;
        
        //calculate number of squares
        let rowHeight = START_HEIGHT + PADDING;
        let columnWidth = START_WIDTH + PADDING;
        let rows = Math.floor(height/rowHeight);
        let columns = Math.floor(width/columnWidth);
        
        for ( let n = 0; n < columns; n++ ) {
            for ( let m = 0; m < rows; m++ ) {
                let x = n * columnWidth + startX;
                let y = m * rowHeight + startY;
                let x2 = x + columnWidth;
                let y2 = y + rowHeight;
                
                let hasX = false;
                let hasY = false;
                for ( let i = 0; i < this.notes.length; i++ ) {
                    let allocation = this.notes[i].actor.get_allocation_box();
                    if ( ( allocation.x1 > x && allocation.x1 < x2 ) ||
                         ( allocation.x2 > x && allocation.x2 < x2 ) ) hasX = true;
                    else hasX = false;
                    if ( ( allocation.y1 > y && allocation.y1 < y2 ) ||
                         ( allocation.y2 > y && allocation.y2 < y2 ) ) hasY = true;
                    else hasY = false;
                    if ( hasX && hasY ) break;
                }
                if ( hasX && hasY ) continue;
                else return [x, y];
            }
        }
        
        return [startX, startY];
    }
}
Signals.addSignalMethods(NoteBox.prototype);


function MyApplet(metadata, orientation, panelHeight, instanceId) {
    this._init(metadata, orientation, panelHeight, instanceId);
}

MyApplet.prototype = {
    __proto__: Applet.Applet.prototype,
    
    _init: function(metadata, orientation, panelHeight, instanceId) {
        try {
            
            this.metadata = metadata;
            this.instanceId = instanceId;
            this.orientation = orientation;
            
            Applet.Applet.prototype._init.call(this, this.orientation, panelHeight, instanceId);
            
            this.contextToggleCollapse = this._applet_context_menu.addAction("Collapse", Lang.bind(this, function() {
                settings.collapsed = !settings.collapsed;
                this.buildPanel();
            }));
            
            this.menuManager = new PopupMenu.PopupMenuManager(this);
            
            this.addNoteContainers();
            this.buildPanel();
            
            settings.connect("collapsed-changed", Lang.bind(this, this.buildPanel));
            
        } catch(e) {
            global.logError(e);
        }
    },
    
    on_applet_removed_from_panel: function() {
        this.noteBox.destroy();
        topBox.destroy();
        bottomBox.destroy();
    },
    
    addNoteContainers: function() {
        //add space to ui group
        let uiGroup = Main.uiGroup;
        
        topBox = new St.Bin({ x_expand: true, x_fill: true, y_expand: true, y_fill: true });
        uiGroup.add_actor(topBox);
        
        bottomBox = new St.Bin({ x_expand: true, x_fill: true, y_expand: true, y_fill: true });
        uiGroup.add_actor(bottomBox);
        uiGroup.lower_child(bottomBox, global.window_group);
        
        this.noteBox = new NoteBox();
        this.noteBox.connect("state-changed", Lang.bind(this, this.setVisibleButtons));
    },
    
    buildPanel: function() {
        if ( this.buttonBox ) this.buttonBox.get_parent().remove_actor(this.buttonBox);
        else this.buildButtons();
        this.actor.destroy_all_children();
        if ( this.menu ) {
            this.menu.destroy();
            this.menu = null;
        }
        
        let buttonBin;
        if ( settings.collapsed ) {
            this.actor.set_track_hover(true);
            let file = Gio.file_new_for_path(this.metadata.path+"/sticky.svg");
            let gicon = new Gio.FileIcon({ file: file });
            let appletIcon;
            if ( this._scaleMode ) {
                appletIcon = new St.Icon({ gicon: gicon,
                                           icon_size: this._panelHeight * .875,
                                           icon_type: St.IconType.FULLCOLOR,
                                           reactive: true,
                                           track_hover: true,
                                           style_class: "applet-icon" });
            }
            else {
                appletIcon = new St.Icon({ gicon: gicon,
                                           icon_size: 22,
                                           icon_type: St.IconType.FULLCOLOR,
                                           reactive: true,
                                           track_hover: true,
                                           style_class: "applet-icon" });
            }
            this.actor.add_actor(appletIcon);
            
            this.menu = new Applet.AppletPopupMenu(this, this.orientation);
            this.menuManager.addMenu(this.menu);
            buttonBin = new St.Bin({ style_class: "sticky-menuBox" });
            this.menu.addActor(buttonBin);
            
            appletIcon.connect("button-press-event", Lang.bind(this, function() { this.menu.toggle(); }));
            
            this.contextToggleCollapse.label.text = "Expand";
        }
        else {
            this.actor.set_track_hover(false);
            buttonBin = new St.Bin({ style_class: "sticky-panelBox" });
            this.actor.add_actor(buttonBin);
            
            this.contextToggleCollapse.label.text = "Collapse";
        }
        
        buttonBin.set_child(this.buttonBox);
    },
    
    buildButtons: function() {
        this.buttonBox = new St.BoxLayout({ style_class: "sticky-buttonBox" });
        
        this.newNote = new PanelButton(this,
                                       this.metadata.path+"/add-symbolic.svg",
                                       "New",
                                       Lang.bind(this.noteBox, this.noteBox.newNote));
        this.buttonBox.add_actor(this.newNote.actor);
        
        this.raiseNotes = new PanelButton(this,
                                          this.metadata.path+"/raise-symbolic.svg",
                                          "Raise",
                                          Lang.bind(this.noteBox, this.noteBox.raiseNotes));
        this.buttonBox.add_actor(this.raiseNotes.actor);
        
        this.lowerNotes = new PanelButton(this,
                                          this.metadata.path+"/lower-symbolic.svg",
                                          "Lower",
                                          Lang.bind(this.noteBox, this.noteBox.lowerNotes));
        this.buttonBox.add_actor(this.lowerNotes.actor);
        
        this.showNotes = new PanelButton(this,
                                         this.metadata.path+"/show-symbolic.svg",
                                         "Show",
                                         Lang.bind(this.noteBox, this.noteBox.lowerNotes));
        this.buttonBox.add_actor(this.showNotes.actor);
        
        this.hideNotes = new PanelButton(this,
                                         this.metadata.path+"/hide-symbolic.svg",
                                         "Hide",
                                         Lang.bind(this.noteBox, this.noteBox.hideNotes));
        this.buttonBox.add_actor(this.hideNotes.actor);
        
        this.setVisibleButtons();
    },
    
    setVisibleButtons: function() {
        if ( notesRaised ) {
            this.showNotes.actor.hide();
            this.hideNotes.actor.show();
            this.raiseNotes.actor.hide();
            this.lowerNotes.actor.show();
        }
        else if ( settings.hideState ) {
            this.showNotes.actor.show();
            this.hideNotes.actor.hide();
            this.raiseNotes.actor.show();
            this.lowerNotes.actor.hide();
        }
        else {
            this.showNotes.actor.hide();
            this.hideNotes.actor.show();
            this.raiseNotes.actor.show();
            this.lowerNotes.actor.hide();
        }
    }
}


function main(metadata, orientation, panelHeight, instanceId) {
    settings = new SettingsManager(metadata.uuid, instanceId);
    let myApplet = new MyApplet(metadata, orientation, panelHeight, instanceId);
    return myApplet;
}
