const Cinnamon = imports.gi.Cinnamon;
const Clutter = imports.gi.Clutter;
const Meta = imports.gi.Meta;
const Pango = imports.gi.Pango;
const St = imports.gi.St;

const Applet = imports.ui.applet;
const DND = imports.ui.dnd;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
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
            this.settings.bindProperty(Settings.BindingDirection.IN, "theme", "theme", function() { this.emit("theme-changed"); });
            
        } catch(e) {
            global.logError(e);
        }
    },
    
    saveNotes:function(notes) {
        this.storedNotes = notes;
    }
}
Signals.addSignalMethods(SettingsManager.prototype);


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
            
            this.text = new St.Entry({  });
            this.actor.add_actor(this.text);
            if ( info ) this.text.text = info.text;
            this.text.clutter_text.set_single_line_mode(false);
            this.text.clutter_text.set_activatable(false);
            this.text.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this.text.clutter_text.line_wrap = true;
            this.text.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
            this.text.clutter_text.set_selectable(true);
            
            this.text.connect("enter-event", Lang.bind(this, function() { this.draggable.inhibit = true }));
            this.text.connect("leave-event", Lang.bind(this, function() { this.draggable.inhibit = false }));
            this.text.clutter_text.connect("button-release-event", Lang.bind(this, this.onButtonRelease));
            this.text.clutter_text.connect("button-press-event", Lang.bind(this, this.onButtonPress));
            this.text.clutter_text.connect("text-changed", Lang.bind(this, function() { this.emit("changed"); }));
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
        global.set_stage_input_mode(Cinnamon.StageInputMode.NORMAL);
        this.trackMouse();
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
        else {
            this.menu.close();
            this.focusText();
        }
        //if ( !this.menu.isOpen ) this.focusText();
        
        //if ( event.get_button() == 3 && !this.menu.isOpen ) return true;
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
        
        return false;
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
    
    focusText: function() {
        let currentMode = global.stage_input_mode;
        if ( currentMode == Cinnamon.StageInputMode.FOCUSED && this.text.has_key_focus() ) return;
        this.previousMode = currentMode;
        if ( currentMode != Cinnamon.StageInputMode.FOCUSED ) {
            global.set_stage_input_mode(Cinnamon.StageInputMode.FOCUSED);
        }
        
        this.text.grab_key_focus();
        if ( notesRaised ) global.set_stage_input_mode(Cinnamon.StageInputMode.FULLSCREEN);
        if ( !this.unfocusId ) this.unfocusId = this.text.connect("key-focus-out", Lang.bind(this, this.unfocusText));
    },
    
    unfocusText: function() {
        if ( this.unfocusId ) this.text.disconnect(this.unfocusId);
        if ( this.previousMode ) global.set_stage_input_mode(this.previousMode);
        else global.set_stage_input_mode(Cinnamon.StageInputMode.NORMAL);
        this.previousMode = null;
    },
    
    getInfo: function() {
        return { text: this.text.text, x: this.actor.x, y: this.actor.y };
    },
    
    copy: function() {
        let cursor = this.text.clutter_text.get_cursor_position();
        let selection = this.text.clutter_text.get_selection_bound();
        let text;
        if ( cursor == selection ) text = this.text.clutter_text.get_text();
        else text = this.text.clutter_text.get_selection();
        St.Clipboard.get_default().set_text(text);
    },
    
    paste: function() {
        St.Clipboard.get_default().get_text(Lang.bind(this, function(cb, text) {
            let cursor = this.text.clutter_text.get_cursor_position();
            let selection = this.text.clutter_text.get_selection_bound();
            if ( cursor != selection ) this.text.clutter_text.delete_selection();
            this.text.clutter_text.insert_text(text, this.text.clutter_text.get_cursor_position());
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
        this.mouseTrackEnabled = false;
        
        this.actor = new Clutter.Group();
        this.actor._delegate = this;
        
        this.dragPlaceholder = new St.Bin({ style_class: "desklet-drag-placeholder" });
        this.dragPlaceholder.hide();
        
        this.initializeNotes();
        bottomBox.add_actor(this.actor);
        this.enableMouseTracking(true);
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
        this.checkMouseTracking();
    },
    
    newNote: function() {
        this.addNote(null);
        this.update();
        this.raiseNotes();
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
            this.actor.show();
            Main.pushModal(this.actor);
            if ( !this.stageEventIds ) {
                this.stageEventIds = [];
                this.stageEventIds.push(global.stage.connect("captured-event", Lang.bind(this, this.handleStageEvent)));
                this.stageEventIds.push(global.stage.connect("enter-event", Lang.bind(this, this.handleStageEvent)));
                this.stageEventIds.push(global.stage.connect("leave-event", Lang.bind(this, this.handleStageEvent)));
            }
            
            notesRaised = true;
        } catch(e) {
            global.logError(e);
        }
    },
    
    lowerNotes: function() {
        try {
            global.reparentActor(this.actor, bottomBox);
            this.actor.show();
            if ( this.stageEventIds ) {
                for ( let i = 0; i < this.stageEventIds.length; i++ ) global.stage.disconnect(this.stageEventIds[i]);
                this.stageEventIds = null;
            }
            if ( notesRaised ) Main.popModal(this.actor);
            notesRaised = false;
        } catch(e) {
            global.logError(e);
        }
    },
    
    hideNotes: function() {
        try {
            this.actor.hide();
            if ( this.stageEventIds ) {
                for ( let i = 0; i < this.stageEventIds.length; i++ ) global.stage.disconnect(this.stageEventIds[i]);
                this.stageEventIds = null;
            }
        } catch(e) {
            global.logError(e);
        }
    },
    
    handleStageEvent: function(actor, event) {
        try {
            
            let target = event.get_source();
            for ( let i = 0; i < this.notes.length; i++ ) {
                if ( this.notes[i].actor == target || this.notes[i].menu.actor == target ) return false;
            }
            
            let type = event.type();
            if ( type == Clutter.EventType.BUTTON_PRESS ) return true;
            if ( type == Clutter.EventType.BUTTON_RELEASE ) {
                this.lowerNotes();
                return true;
            }
            
        } catch(e) {
            global.logError(e);
        }
        return false;
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
        mouseTrackEnabled = -1; // forces an update of all mouse tracks
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
        if( this.mouseTrackEnabled != enable ) {
            this.mouseTrackEnabled = enable;
            if( enable ) {
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
        if ( Main.desktop_layout != Main.LAYOUT_CLASSIC ) height -= Main.panel2.actor.height;
        
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


function MyApplet(metadata, orientation, panelHeight, instanceId) {
    this._init(metadata, orientation, panelHeight, instanceId);
}

MyApplet.prototype = {
    __proto__: Applet.TextIconApplet.prototype,
    
    _init: function(metadata, orientation, panelHeight, instanceId) {
        try {
            
            this.metadata = metadata;
            this.instanceId = instanceId;
            this.orientation = orientation;
            
            Applet.TextIconApplet.prototype._init.call(this, this.orientation, panelHeight);
            
            this.menuManager = new PopupMenu.PopupMenuManager(this);
            this.menu = new Applet.AppletPopupMenu(this, this.orientation);
            this.menuManager.addMenu(this.menu);
            
            this.addNoteContainers();
            
            this.set_applet_icon_path(this.metadata.path+"/sticky.svg");
            
            this.buildMenu();
            
        } catch(e) {
            global.logError(e);
        }
    },
    
    on_applet_clicked: function(event) {
        this.menu.toggle();
    },
    
    on_applet_removed_from_panel: function() {
        this.noteBox.destroy();
        topBox.destroy();
        bottomBox.destroy();
    },
    
    addNoteContainers: function() {
        //add space to ui group
        let uiGroup = Main.uiGroup;
        
        topBox = new St.Bin({ x_expand: true, x_fill: true, y_expand: true, y_fill: true, height: 200, width: 200 });
        uiGroup.add_actor(topBox);
        
        bottomBox = new St.Bin({ x_expand: true, x_fill: true, y_expand: true, y_fill: true });
        uiGroup.add_actor(bottomBox);
        uiGroup.lower_child(bottomBox, global.window_group);
        
        this.noteBox = new NoteBox();
    },
    
    buildMenu: function() {
        
        let newNote = new PopupMenu.PopupMenuItem("New");
        this.menu.addMenuItem(newNote);
        newNote.connect("activate", Lang.bind(this.noteBox, this.noteBox.newNote));
        
        let raiseNotes = new PopupMenu.PopupMenuItem("Raise");
        this.menu.addMenuItem(raiseNotes);
        raiseNotes.connect("activate", Lang.bind(this.noteBox, this.noteBox.raiseNotes));
        
        let lowerNotes = new PopupMenu.PopupMenuItem("Lower");
        this.menu.addMenuItem(lowerNotes);
        lowerNotes.connect("activate", Lang.bind(this.noteBox, this.noteBox.lowerNotes));
    }
}


function main(metadata, orientation, panelHeight, instanceId) {
    settings = new SettingsManager(metadata.uuid, instanceId);
    let myApplet = new MyApplet(metadata, orientation, panelHeight, instanceId);
    return myApplet;
}
