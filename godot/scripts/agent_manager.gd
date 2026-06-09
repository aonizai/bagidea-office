extends Node
## Maps agent IDs from daemon events to characters in the world, and
## choreographs them: desks for work, cafeteria for idle, security for
## approvals. OEP v0.2: events may carry a `task` id, so one agent can own
## several missions at once (board cards are per-task, body is per-agent).

const AgentScript := preload("res://scripts/agent_sprite.gd")
const Fx := preload("res://scripts/fx_factory.gd")
const Burst := preload("res://scripts/burst_factory.gd")

@onready var world: Node3D = get_node("../World")

var agents := {}  # id -> {node, state, desk, bed, id, tasks: {task_id: true}}
var roster := {}  # id -> {name, role, avatar} — the daemon's persistent registry
var ghosts := {}  # sub id ("pixel#s1") -> {node, desk: GHOST_DESKS index or -1}
var meeting_ghosts := {}  # agent id -> stand-in clone (owner too busy to attend)
var ghost_desks_free: Array[int] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
var _sec_pending := {}  # task -> a Security walk is scheduled but not yet committed
var ceo_hold_until := 0.0  # the boss stands still while giving/receiving work
var _tv_watchers := 0
var supervising := {}  # delegate id -> {ghost: Sprite3D or null} (main keeps tabs)
var awaiting_delivery := {}  # delegate id -> true (walks the result to main)
var desk_pool: Array[String] = ["desk1", "desk2", "desk3", "desk4", "desk5", "desk6"]
# Idle agents spread EVENLY across the cafeteria AND the recreation room — the
# cafe matters as much as the rec room, so the office never crowds one corner.
var seat_cycle: Array[String] = ["cafe_s1", "rec_s1", "cafe_c", "rec_s2", "cafe_s2", "rec_s3", "cafe_s1", "rec_s4"]
var meeting_cycle: Array[String] = ["m_s1", "m_s2", "m_s3", "m_s4"]
var bed_pool: Array[String] = ["bed1", "bed2", "b3", "b4", "b5", "b6", "b7", "b8"]
var ceo: Sprite3D

var _pos_req: HTTPRequest
var _pos_busy := false

func _ready() -> void:
	# Hold off ambient cinematic close-ups so the OPENING shot is the CEO intro,
	# not whichever staffer happens to move first.
	_focus_cd = Time.get_ticks_msec() / 1000.0 + 14.0
	_spawn_ceo.call_deferred()
	_main_wander_loop()
	_idle_life_loop()
	_nap_loop()
	# Live positions → daemon → overlay map (1 Hz, fire-and-forget).
	_pos_req = HTTPRequest.new()
	add_child(_pos_req)
	_pos_req.request_completed.connect(func(_a, _b, _c, _d): _pos_busy = false)
	var t := Timer.new()
	t.wait_time = 1.0
	t.autostart = true
	t.timeout.connect(_stream_positions)
	add_child(t)

## Rooms were rearranged (jigsaw swap) → drop everyone back onto their home
## anchor so they stand in the correct room. Normal walking resumes after.
func resnap_agents() -> void:
	if not is_instance_valid(world): return
	for id in agents:
		var a: Dictionary = agents[id]
		if not is_instance_valid(a.node): continue
		var home: String = String(a.get("desk", ""))
		if home == "" or not world.WP.has(home): home = "ops_c"
		if world.WP.has(home): a.node.teleport(world.WP[home])
	if is_instance_valid(ceo) and world.WP.has("ceo_desk"):
		ceo.teleport(world.WP["ceo_desk"])

func _stream_positions() -> void:
	if _pos_busy:
		return
	var list := []
	for id in agents:
		var a: Dictionary = agents[id]
		if is_instance_valid(a.node):
			list.append({"id": id, "x": a.node.position.x, "z": a.node.position.z,
				"state": a.state})
	if is_instance_valid(ceo) and not agents.has("ceo"):
		list.append({"id": "ceo", "x": ceo.position.x, "z": ceo.position.z, "state": "idle"})
	for sub in ghosts:
		var gh: Dictionary = ghosts[sub]
		if is_instance_valid(gh.node):
			list.append({"id": sub, "x": gh.node.position.x, "z": gh.node.position.z,
				"state": "ghost"})
	if list.is_empty():
		return
	_pos_busy = true
	var err := _pos_req.request("http://127.0.0.1:8787/pos",
		["content-type: application/json"], HTTPClient.METHOD_POST,
		JSON.stringify({"agents": list}))
	if err != OK:
		_pos_busy = false

func set_connected(connected: bool) -> void:
	world.set_totem(connected)

## Single place where an agent's state changes — body, plate, everything.
func _set_state(a: Dictionary, state: String) -> void:
	if state == "idle" and a.state != "idle":
		a["idle_since"] = Time.get_ticks_msec() / 1000.0  # the nap clock
	a.state = state
	a.node.set_state(state)

## Occasional cinematic close-up on something interesting — rate-limited so
## the wallpaper keeps its calm diorama feel between shots.
var _focus_cd := 0.0

## A guaranteed camera move for a fresh order: if the camera isn't already
## focusing, snap to `node` so the scene never sits dead-still while
## something important kicks off (a new task, an order from the CEO).
func _focus_kick(node: Node3D, dur := 7.0) -> void:
	if not is_instance_valid(node):
		return
	var rig := get_node_or_null("../CameraRig")
	if rig and rig.has_method("is_focusing") and not rig.is_focusing():
		rig.focus_on(node, dur)
		_focus_cd = Time.get_ticks_msec() / 1000.0 + randf_range(18.0, 38.0)

func _maybe_focus(node: Node3D, chance := 0.45, dur := 7.0) -> void:
	var now := Time.get_ticks_msec() / 1000.0
	if now < _focus_cd or randf() > chance or not is_instance_valid(node):
		return
	_focus_cd = now + randf_range(28.0, 60.0)
	var rig := get_node_or_null("../CameraRig")
	if rig:
		rig.focus_on(node, dur)

## Symbol FX (check / X / alert / thumbs / notes) play on the HUD layer —
## ABOVE the nameplate that was eating the in-world version. Body bursts
## (sparkle, light, warp, heart) stay in the 3D world via Fx.spawn.
func _fx(a: Dictionary, name: String, loops := 1) -> void:
	if not (a.has("node") and is_instance_valid(a.node)):
		return
	var hud := get_node_or_null("../Hud")
	var info: Array = Fx.strip(name)
	if hud and not info.is_empty():
		hud.fx(a.node, info[0], info[1], loops)

# ---------------------------------------------------------------- events

func handle(evt: Dictionary) -> void:
	var type := str(evt.get("type", ""))
	if type == "ui.daylight":
		get_node("../").apply_daylight_event(evt)
		return
	if type == "ui.sound":
		Sfx.enabled = bool(evt.get("on", true))
		return
	if type == "ui.visibility":
		# Office hidden: silence + crawl the renderer; agents keep WORKING.
		var on := bool(evt.get("on", true))
		Sfx.hidden = not on
		Engine.max_fps = 30 if on else 2
		return
	if type.begins_with("ui."):
		return  # overlay debug beacons aren't agents
	if type == "roster.sync":
		Sfx.enabled = bool(evt.get("sound", true))
		_apply_roster(evt)
		return
	if type == "roster.removed":
		_remove_agent(str(evt.get("agent", "")))
		return
	if type == "world.pos":
		return  # our own position stream echoing back — not an agent event
	if not evt.has("agent") and not evt.has("agents"):
		return  # agent-less events must never spawn a default "agent" ghost
	# Replay Theater was removed — stale theater frames from old journals
	# must never animate anything.
	if type.begins_with("theater.") or evt.get("theater", false):
		return
	var theatrical: bool = false  # kept so downstream guards stay untouched

	# Sub-agent traffic → ghost clones, never real hires. Ghosts live only in
	# the present: journal replays and theater never resurrect them.
	if evt.has("sub"):
		if not evt.get("replay", false) and not theatrical:
			_handle_sub(type, evt)
		return
	var hook_id := str(evt.get("agent", ""))
	if hook_id.contains("#"):
		# Hook events from a sub-agent's own claude process (progress, perms).
		if not evt.get("replay", false) and not theatrical:
			_route_hook_to_ghost(hook_id, type, evt)
		return

	# Collaboration events may target several agents at once.
	if type in ["collab.started", "collab.ended"] and evt.has("agents"):
		if type == "collab.started":
			# The whiteboard carries the real meeting topic.
			world.whiteboard_reset("◤ " + str(evt.get("text", "MEETING")).left(46))
		for member in evt.agents:
			var sub := evt.duplicate()
			sub.erase("agents")
			sub["agent"] = str(member)
			handle(sub)
		if type == "collab.ended":
			_wb_clear_later()
		return

	var id := str(evt.get("agent", "agent"))
	var task := str(evt.get("task", id))  # agent-as-task fallback (tier-1 adapters)
	if type == "agent.offline":
		_to_dorm(id)
		return
	var a: Dictionary = _ensure(id)
	if a.state == "offline" or a.state == "resting":
		_set_state(a, "idle")
		if a.bed != "":
			bed_pool.append(a.bed)  # check out of the bunk
			a.bed = ""
		a.node.set_status("good morning ☀")
		Fx.spawn(a.node, "sparkle", Vector3(0, 0.6, 0), 0.045)  # wraps the body
		_clear_status_later(a, 3.0)
	match type:
		"agent.online":
			pass  # _ensure already spawned them
		"task.started":
			a.tasks[task] = true
			_to_desk(a)
			if not theatrical:
				Sfx.play("blip", 600)
				_maybe_focus(a.node, 0.3)
				_focus_kick(a.node, 6.0)
				world.board_set(task, "running", id)
		"task.progress":
			if a.state != "working":
				a.tasks[task] = true
				_to_desk(a)
				if not theatrical:
					world.board_set(task, "running", id)
			a.node.set_status(str(evt.get("tool", "working…")))
		"task.completed":
			a.tasks.erase(task)
			_fx(a, "success")
			if not theatrical:
				Sfx.play("chime")
				world.board_set(task, "done", id)
				_board_clear_later(task)
				_end_supervision(id)
			if a.tasks.is_empty():
				if awaiting_delivery.has(id) and id != "main":
					_deliver_to_main(a)  # walk the finished work to the boss's boss
				else:
					_finish(a, "done ✓")
		"task.failed":
			a.tasks.erase(task)
			awaiting_delivery.erase(id)  # nothing to deliver
			_fx(a, "failure")
			if not theatrical:
				Sfx.play("buzz")
				world.board_set(task, "failed", id)
				_board_clear_later(task)
				_end_supervision(id)
			if a.tasks.is_empty():
				_finish(a, "failed ✗")
		"perm.requested":
			if not theatrical:
				Sfx.play("ding")
				_maybe_focus(a.node, 0.85, 8.0)
			_set_state(a, "blocked")
			a.node.set_status("needs approval ⚠")
			_fx(a, "alert", 3)
			# Don't bolt for Security yet — granted tools are auto-approved by the
			# daemon almost instantly. Wait a beat; if approval/denial lands first,
			# the agent never leaves its desk.
			_sec_pending[task] = true
			_security_walk_after_grace(a, id, task)
		"perm.approved":
			_sec_pending.erase(task)
			if not theatrical:
				Sfx.play("blip2")
			_set_state(a, "working")
			a.node.set_status("approved ✓")
			_fx(a, "thumbs_up")
			if a.desk != "":
				_walk(a.node, a.desk)
			if not theatrical:
				world.board_set(task, "running", id)
		"perm.denied":
			_sec_pending.erase(task)
			if not theatrical:
				Sfx.play("buzz")
			a.tasks.erase(task)
			_fx(a, "thumbs_down")
			if not theatrical:
				world.board_set(task, "failed", id)
				_board_clear_later(task)
			if a.tasks.is_empty():
				_finish(a, "denied ✗")
		"ceo.summon":
			# Chain of command: the Director comes over and TAILS the boss —
			# truly walking together while the order is given.
			if not theatrical:
				Sfx.play("blip2")
				_maybe_focus(a.node, 0.7)
				_focus_kick(a.node, 7.0)
			_set_state(a, "working")
			a.node.set_status("รับคำสั่งจาก CEO 📋")
			a["hold_at_ceo"] = Time.get_ticks_msec() / 1000.0 + 28.0
			if is_instance_valid(ceo):
				ceo_hold_until = Time.get_ticks_msec() / 1000.0 + 20.0
				ceo.walk_to([ceo.position])  # boss stops mid-stride to give the order
				ceo.set_status("สั่งงาน 🗣")
				Fx.spawn(ceo, "heart", Vector3(0, 1.3, 0))
				_tail_ceo(a)
		"task.delegated":
			# ...then walks to the assignee, hands the work over, and STAYS
			# on their heels until they report back. More than one delegate?
			# Supervisor clones split off to shadow the rest.
			a["hold_at_ceo"] = 0.0  # order taken — moving out
			var tgt := str(evt.get("target", ""))
			a.node.set_status("มอบหมาย → " + tgt + " 📋")
			if not theatrical:
				Sfx.play("blip")
			if agents.has(tgt) and not supervising.has(tgt):
				agents[tgt].node.set_status("รับงานใหม่ ✏")
				awaiting_delivery[tgt] = true  # they'll walk the result back
				# Head to the SHARED ops floor at once — never the Director's desk.
				if tgt != "main":
					_to_desk(agents[tgt])
				if supervising.is_empty():
					supervising[tgt] = {"ghost": null}
					_supervise(tgt, a.node)
				elif supervising.size() < 4:
					_spawn_supervisor(tgt)
		"reminder":
			# The Director personally walks over to remind the boss.
			if not theatrical:
				Sfx.play("ding")
				_maybe_focus(a.node, 0.8, 8.0)
			a.node.set_status("🔔 " + str(evt.get("text", "เตือนนัด")).left(24))
			if is_instance_valid(ceo):
				ceo_hold_until = Time.get_ticks_msec() / 1000.0 + 12.0
				a.node.walk_to(world.path_between(a.node.position,
					ceo.position + Vector3(-1.15, 0, 0.6)))
				Fx.spawn(ceo, "heart", Vector3(0, 1.3, 0))
			_clear_status_later(a, 10.0)
		"ceo.report":
			# The round trip closes: the Director walks the summary to the boss.
			if not theatrical:
				Sfx.play("chime")
				_maybe_focus(a.node, 0.6, 8.0)
			a.node.set_status("ส่งสรุปงานให้ CEO 📋")
			if is_instance_valid(ceo):
				ceo_hold_until = Time.get_ticks_msec() / 1000.0 + 12.0
				a.node.walk_to([ceo.position + Vector3(-1.15, 0, 0.6)])
				Fx.spawn(ceo, "heart", Vector3(0, 1.3, 0))
			_clear_status_later(a, 9.0)
		"subagent.split":
			# The parent stays at its desk awaiting its clones' reports.
			_to_desk(a)
			_maybe_focus(a.node, 0.55, 7.0)
			a.node.set_status("รอผล sub-agents 👻")
		"voice.say":
			# An agent spoke out loud — show what they said as a speech bubble too.
			if not evt.get("replay", false):
				a.node.set_status("🗣 " + str(evt.get("text", "")).left(30))
				_fx(a, "music")
				_clear_status_later(a, 6.0)
		"skill.created":
			# Hermes moment: the agent distilled its work into a new skill.
			if not theatrical:
				Sfx.play("tada")
			a.node.set_status("📚 learned: " + str(evt.get("skill", "")))
			Fx.spawn(a.node, "light_burst", Vector3(0, 0.45, 0), 0.045)  # wraps the body
			_clear_status_later(a, 6.0)
		"chat.message":
			# Speech bubble: first line of what the agent actually said.
			var text := str(evt.get("text", "")).split("\n")[0]
			if not evt.get("replay", false):
				_fx(a, "music")
				if not theatrical:
					Sfx.play("blip", 800)
			# In a meeting, words land on the whiteboard (truth, not theater) —
			# spoken by the agent, or by their stand-in clone.
			if meeting_ghosts.has(id):
				world.whiteboard_add(id, text)
				if is_instance_valid(meeting_ghosts[id]):
					meeting_ghosts[id].set_status("💬 " + text.left(28))
			else:
				a.node.set_status("💬 " + text.left(28))
				if a.state == "meeting":
					world.whiteboard_add(id, text)
				elif evt.get("ambient", false):
					# A lone ambient mood line clears itself after a beat.
					_clear_status_later(a, 6.0)
		"collab.started":
			# Agents physically gather at the meeting table (design doc 4.7).
			if not theatrical:
				Sfx.play("blip2", 400)
				_maybe_focus(a.node, 0.5, 8.0)
			var seat: String = meeting_cycle.pop_front()
			meeting_cycle.append(seat)
			if a.state == "working" and not a.tasks.is_empty():
				# Too busy to leave the desk? A translucent stand-in attends.
				_spawn_meeting_ghost(id, seat)
			else:
				_set_state(a, "meeting")
				a.node.set_status("meeting 🗣")
				_walk(a.node, seat)
		"collab.ended":
			if meeting_ghosts.has(id):
				_dissolve_meeting_ghost(id)
			elif a.state == "meeting":
				world.whiteboard_add("", "— adjourned —")
				if a.tasks.is_empty():
					_finish(a, "done ✓")
				else:
					_set_state(a, "working")
					a.node.set_status("working…")
					if a.desk != "":
						_walk(a.node, a.desk)

# ---------------------------------------------------------------- roster

## Registry snapshot from the daemon: staff exist in the world even before
## their first task, identities follow edits live, deletions clean up.
func _apply_roster(evt: Dictionary) -> void:
	var list: Dictionary = evt.get("agents", {})
	roster = {}
	for id in list:
		var r: Dictionary = list[id]
		roster[id] = {"name": str(r.get("name", id)), "role": str(r.get("role", "Staff")),
			"avatar": int(r.get("avatar", 1)), "aura": str(r.get("aura", ""))}
	for id in roster:
		if id == "ceo":
			if is_instance_valid(ceo):
				ceo.apply_identity(roster[id].name, roster[id].role, roster[id].avatar)
				ceo.set_aura(roster[id].aura)
			continue
		var a: Dictionary = _ensure(id)
		a.registered = true
		a.node.apply_identity(roster[id].name, roster[id].role, roster[id].avatar)
		a.node.set_aura(roster[id].aura)
		a.node.set_state(a.state)
	# Registry agents deleted while this renderer was away.
	for id in agents.keys().duplicate():
		if agents[id].get("registered", false) and not roster.has(id):
			_remove_agent(id)

func _remove_agent(id: String) -> void:
	if id == "" or id in ["main", "ceo"] or not agents.has(id):
		return
	var a: Dictionary = agents[id]
	_release_desk(a)
	if a.bed != "":
		bed_pool.append(a.bed)
	for t in a.tasks:
		world.board_set(t, "none")
	# Farewell warp where they stood (parented to the world — the node dies).
	Fx.spawn(world, "warp_out", a.node.position + Vector3(0, -0.2, 0), 0.022)
	a.node.queue_free()  # _exit_tree unregisters the nameplate
	agents.erase(id)

# ---------------------------------------------------------------- ghosts
# Sub-agent clones: a translucent copy of the parent splits off, floats up
# (through walls — they're ghosts) to a free desk on the Ghost Deck, works,
# then glides home and dissolves back into its owner.

func _handle_sub(type: String, evt: Dictionary) -> void:
	var sub := str(evt.get("sub", ""))
	if sub == "":
		return
	match type:
		"subagent.spawned":
			Sfx.play("whoosh")
			_spawn_ghost(str(evt.get("agent", "")), sub, str(evt.get("text", "")))
			if ghosts.has(sub) and is_instance_valid(ghosts[sub].node):
				_maybe_focus(ghosts[sub].node, 0.5)
		"subagent.progress":
			if ghosts.has(sub) and is_instance_valid(ghosts[sub].node):
				ghosts[sub].node.set_status(str(evt.get("tool", "working…")))
		"chat.message":
			if ghosts.has(sub) and is_instance_valid(ghosts[sub].node):
				var text := str(evt.get("text", "")).split("\n")[0]
				ghosts[sub].node.set_status("💬 " + text.left(28))
		"subagent.done":
			# Success or failure deserves the RIGHT sound, not a generic woosh.
			Sfx.play("chime" if bool(evt.get("ok", true)) else "buzz")
			_despawn_ghost(sub, bool(evt.get("ok", true)))

func _spawn_ghost(parent_id: String, sub: String, job: String) -> void:
	if ghosts.has(sub) or parent_id == "":
		return
	var pa: Dictionary = _ensure(parent_id)
	var pnode: Sprite3D = pa.node
	var g := _make_char(parent_id)
	# A clone wears the parent's EXACT face: copy identity off the live node —
	# _make_char's hash fallback may have rolled a different sheet, and ghosts
	# never receive the roster's apply_identity correction.
	g.npc_index = pnode.npc_index
	g.suit_color = pnode.suit_color
	g.hair_color = pnode.hair_color
	g.skin_color = pnode.skin_color
	g.rank = "ghost"                # spectral dressing on the plate
	g.agent_name = str(pnode.agent_name) + " · " + sub.get_slice("#", 1).to_upper()
	g.agent_role = "sub-agent"
	get_parent().add_child(g)
	g.set_ghost()
	g.position = pnode.position + Vector3(0.25, 0, 0.2)
	var di := -1
	if ghost_desks_free.size() > 0:
		di = ghost_desks_free.pop_front()
	var target: Vector3 = world.ghost_stand(di) if di >= 0 \
		else world.ghost_stand(0) + Vector3(randf_range(-1.6, 1.6), 0.6, randf_range(-1.2, 1.2))
	ghosts[sub] = {"node": g, "desk": di, "spot": target}
	g.set_state("working")
	g.set_status("👻 " + job.replace("\n", " ").left(26))
	Burst.spawn(world, pnode.position)  # 💥 the split moment earns a show
	_maybe_focus(g, 0.85, 7.0)
	Sfx.play("split")
	# Materialize (set_ghost fades itself in) and HURRY to the deck — on the
	# walkable graph like everyone else, just much faster, via the glass
	# stairs in the server room.
	g.walk_to(_ghost_desk_route(g, target))

## Ground → deck: graph walk to the server room, climb the stairs, desk.
func _ghost_desk_route(g: Sprite3D, spot: Vector3) -> Array:
	var pts: Array = []
	if g.position.y <= 1.5:
		# Coming from the ground: walk straight to the stair FOOT (wherever the
		# deck sits now) along the A* graph — not via a hardcoded server room —
		# then up to the stair top. Already on the deck? Go straight to the desk,
		# no needless trip back up the stairs.
		pts += world.path_between(g.position, world.ghost_stair_base())
		pts.append(world.ghost_stair_top())
	pts.append(spot)
	return pts

## Deck (or anywhere) → a ground waypoint, descending the stairs if needed.
func _ghost_ground_route(g: Sprite3D, target_wp: String) -> Array:
	var pts: Array = []
	var start: Vector3 = g.position
	if start.y > 1.5:
		pts.append(world.ghost_stair_top())
		pts.append(world.ghost_stair_base())
		start = world.ghost_stair_base()
	pts += world.path_to(start, target_wp)
	return pts

func _despawn_ghost(sub: String, ok: bool) -> void:
	if not ghosts.has(sub):
		return
	var gh: Dictionary = ghosts[sub]
	ghosts.erase(sub)
	if gh.desk >= 0:
		ghost_desks_free.append(gh.desk)
	var g: Sprite3D = gh.node
	if not is_instance_valid(g):
		return
	g.set_status("done ✓" if ok else "failed ✗")
	var hud := get_node_or_null("../Hud")
	var info: Array = Fx.strip("success" if ok else "failure")
	if hud and not info.is_empty():
		hud.fx(g, info[0], info[1], 1)
	_maybe_focus(g, 0.7, 6.0)  # the merge is a show too
	# Hurry home along the graph (down the stairs) and dissolve into the owner.
	var dur := 0.0
	var pid := sub.get_slice("#", 0)
	if agents.has(pid) and is_instance_valid(agents[pid].node):
		var home: Vector3 = agents[pid].node.position
		var pts: Array = []
		var start: Vector3 = g.position
		if start.y > 1.5:
			pts.append(world.ghost_stair_top())
			pts.append(world.ghost_stair_base())
			start = world.ghost_stair_base()
		pts += world.path_between(start, home)
		dur = g.walk_to(pts)
	await get_tree().create_timer(maxf(dur, 0.1) + 0.5).timeout
	if is_instance_valid(g):
		# Merging back deserves a pop too — a softer echo of the split.
		Burst.spawn(world, g.position, 0.65)
		Sfx.play("whoosh")
		g.ghost_dissolve()

## Walk to Security only if the request is STILL unresolved after a short
## grace — granted tools get auto-approved within milliseconds, so the agent
## should keep working at its desk instead of bolting for the window.
func _security_walk_after_grace(a: Dictionary, id: String, task: String) -> void:
	await get_tree().create_timer(3.0).timeout   # be sure a trip is really needed before leaving the desk
	if not _sec_pending.get(task, false):
		return
	_sec_pending.erase(task)
	if not is_instance_valid(a.node) or a.state != "blocked":
		return
	_walk(a.node, "sec_window")
	_pulse_security()
	world.board_set(task, "blocked", id)

## Same grace for a ghost: only head down to Security if still unresolved.
func _ghost_security_after_grace(id: String) -> void:
	await get_tree().create_timer(3.0).timeout   # be sure a trip is really needed before leaving the desk
	if not _sec_pending.erase("g:" + id):
		return   # approved/denied already landed — it never had to leave
	if not ghosts.has(id) or not is_instance_valid(ghosts[id].node):
		return
	var g: Sprite3D = ghosts[id].node
	g.walk_to(_ghost_ground_route(g, "sec_window"))
	_pulse_security()

## The Ghost Deck moved (editor nudge) or rooms were swapped → re-target every
## working ghost to the deck's CURRENT desk world position, live, even mid-task.
func reseat_ghosts() -> void:
	for sub in ghosts:
		var gh: Dictionary = ghosts[sub]
		if gh.desk < 0 or not is_instance_valid(gh.node):
			continue
		gh.spot = world.ghost_stand(gh.desk)
		gh.node.walk_to(_ghost_desk_route(gh.node, gh.spot))

func _route_hook_to_ghost(id: String, type: String, evt: Dictionary) -> void:
	if not ghosts.has(id) or not is_instance_valid(ghosts[id].node):
		return
	var gh: Dictionary = ghosts[id]
	var g: Sprite3D = gh.node
	match type:
		"task.progress":
			g.set_status(str(evt.get("tool", "working…")))
		"perm.requested":
			# Like everyone else: don't leave the desk until we know a trip is
			# really needed — granted tools auto-approve in a blink. Only after the
			# grace (still unresolved) does the ghost head down to Security.
			g.set_status("needs approval ⚠")
			_sec_pending["g:" + id] = true
			_ghost_security_after_grace(id)
		"perm.approved":
			g.set_status("approved ✓")
			_sec_pending.erase("g:" + id)
			# Only walk back if it ACTUALLY left for Security. An auto-approved tool
			# (granted / allow-forever) never moved it off the deck, so don't make
			# it twitch up-and-down the stairs for nothing.
			if g.position.distance_to(gh.spot) > 1.5:
				g.walk_to(_ghost_desk_route(g, gh.spot))
		"perm.denied":
			g.set_status("denied ✗")
			_sec_pending.erase("g:" + id)
			if g.position.distance_to(gh.spot) > 1.5:
				g.walk_to(_ghost_desk_route(g, gh.spot))

# ---------------------------------------------------------------- agents

func _ensure(id: String) -> Dictionary:
	if agents.has(id):
		return agents[id]
	# Events aimed at "ceo" act on the one true CEO body — never a clone.
	if id == "ceo" and is_instance_valid(ceo):
		var c := {"node": ceo, "state": "idle", "desk": "", "bed": "", "id": "ceo", "tasks": {}}
		agents["ceo"] = c
		return c
	# New hire: walk in through the lobby front door.
	var node := _make_char(id)
	node.position = world.WP["spawn"]
	get_parent().add_child(node)
	node.set_status(id)
	var a := {"node": node, "state": "idle", "desk": "", "bed": "", "id": id, "tasks": {}}
	agents[id] = a
	# New hires teleport in — a little sci-fi warp at the door.
	Sfx.play("door_in")
	Fx.spawn(node, "warp_in", Vector3(0, -0.2, 0), 0.022)
	# The main agent heads to the executive office; everyone else idles in cafe.
	_walk(node, "exec_c" if id == "main" else _next_seat())
	_clear_status_later(a, 5.0)
	return a

## Offline agents don't vanish — they walk to the dormitory and sleep
## (design doc: the dorm IS the offline state, visible and honest).
func _to_dorm(id: String) -> void:
	if not agents.has(id):
		return
	var a: Dictionary = agents[id]
	_release_desk(a)
	for t in a.tasks:
		world.board_set(t, "none")
	a.tasks.clear()
	Sfx.play("door_out")
	_set_state(a, "offline")
	a.node.set_status("offline 💤")
	# Reserve a bunk (8 total); overflow rests in the recreation room.
	if bed_pool.size() > 0:
		a.bed = bed_pool.pop_front()
		_walk(a.node, a.bed)
	else:
		_walk(a.node, "rec_s4")

func _to_desk(a: Dictionary) -> void:
	if a.desk == "":
		if a.id == "main":
			a.desk = "lead_desk"  # the Director's own workstation
		else:
			a.desk = desk_pool.pop_front() if desk_pool.size() > 0 else "ops_c"
	_set_state(a, "working")
	a.node.set_status("thinking…")
	# Taking an order in person: stay with the CEO while planning — his
	# own computer can wait until the hand-overs are done.
	if a.id == "main" and Time.get_ticks_msec() / 1000.0 < float(a.get("hold_at_ceo", 0.0)):
		return
	# Face the monitor (north) once seated — DIR_UP = 2 in agent_sprite.
	_walk(a.node, a.desk, a.node.DIR_UP)

## Finished delegated work gets WALKED to the Director — a real hand-back.
func _deliver_to_main(a: Dictionary) -> void:
	awaiting_delivery.erase(a.id)
	_release_desk(a)
	_set_state(a, "idle")
	a.node.set_status("เอางานไปส่ง 📦")
	if agents.has("main") and is_instance_valid(agents["main"].node):
		var m: Sprite3D = agents["main"].node
		var d: float = a.node.walk_to(world.path_between(a.node.position,
			m.position + Vector3(0.9, 0, 0.5)))
		await get_tree().create_timer(d + 0.4).timeout
		if is_instance_valid(a.node):
			Sfx.play("page")
			Fx.spawn(a.node, "sparkle", Vector3(0, 0.5, 0), 0.035)
			a.node.set_status("ส่งงานแล้ว ✓")
			if is_instance_valid(m):
				m.set_status("รับงานจาก " + str(a.node.agent_name) + " 📦")
				_clear_status_later(agents["main"], 5.0)
	await get_tree().create_timer(2.5).timeout
	if a.state == "idle" and is_instance_valid(a.node):
		_walk(a.node, _next_seat())
		_clear_status_later(a, 3.0)

func _finish(a: Dictionary, label: String) -> void:
	a.node.set_status(label)
	_maybe_focus(a.node, 0.5, 6.0)  # a finished task is worth a beat
	_release_desk(a)
	_set_state(a, "idle")
	await get_tree().create_timer(2.0).timeout
	if a.state == "idle":  # may have started a new task meanwhile
		_walk(a.node, "exec_c" if a.id == "main" else _next_seat())
		_clear_status_later(a, 4.0)

func _release_desk(a: Dictionary) -> void:
	if a.desk != "" and not a.desk in ["ops_c", "ceo_desk"]:
		desk_pool.append(a.desk)
	a.desk = ""

func _next_seat() -> String:
	var seat: String = seat_cycle.pop_front()
	seat_cycle.append(seat)
	return seat

## The minutes board takes a bow a few seconds after the meeting adjourns.
func _wb_clear_later(delay := 8.0) -> void:
	await get_tree().create_timer(delay).timeout
	world.whiteboard_reset("")

func _board_clear_later(id: String, delay := 10.0) -> void:
	await get_tree().create_timer(delay).timeout
	world.board_clear_if_finished(id)

func _clear_status_later(a: Dictionary, delay: float) -> void:
	await get_tree().create_timer(delay).timeout
	if a.state == "idle":
		a.node.set_status("")

func _walk(node: Sprite3D, target: String, face_dir := -1) -> float:
	# Any walk that ENDS at a work desk faces the monitor (north) on arrival, so
	# seated agents always look at their screen — no matter which path sent them
	# there (e.g. the Director returning from the CEO). The CEO console is its
	# own special case and is left facing the room.
	if face_dir < 0 and (target.begins_with("desk") or target == "lead_desk"):
		face_dir = node.DIR_UP
	var path: Array = world.path_to(node.position, target)
	# Shared gathering spots (room centres, café/rec/meeting seats, lobby) are
	# visited by several characters — scatter the final step so they never stand
	# on top of each other. Personal desks/beds stay exact (single occupant).
	if path.size() > 0 and _is_shared_spot(target):
		# Deterministic ring offset per agent: different people never stack on
		# the same spot, and the same person is stable across visits.
		var hh: int = abs(hash(node.agent_name))
		var ang := float(hh % 360) * 0.01745329
		# Room CENTRES usually hold a table — ring agents WIDE around it so they
		# never stand on it; seats get just a small scatter so nobody overlaps.
		var base: float = 1.5 if target.ends_with("_c") else 0.7
		var rad: float = base + float((hh / 360) % 80) * 0.01
		path[path.size() - 1] += Vector3(cos(ang) * rad, 0, sin(ang) * rad)
	return node.walk_to(path, face_dir)

func _is_shared_spot(target: String) -> bool:
	return target.ends_with("_c") or target.begins_with("cafe") \
		or target.begins_with("rec_s") or target.begins_with("m_s") \
		or target == "spawn"

func _make_char(id: String) -> Sprite3D:
	var s := Sprite3D.new()
	s.set_script(AgentScript)
	# Portable hash (mirrored in overlay.html) so the web UI shows the same
	# face/role for each agent as the world does.
	var h := 0
	for b in id.to_utf8_buffer():
		h = (h * 31 + int(b)) % 1000003
	var hue := float(h % 360) / 360.0
	s.suit_color = Color.from_hsv(hue, 0.5, 0.45)
	s.hair_color = Color.from_hsv(fmod(hue + 0.35, 1.0), 0.45, 0.22)
	s.skin_color = [Color8(236, 188, 152), Color8(208, 152, 110), Color8(140, 95, 66)][(h / 360) % 3]
	s.tie_color = Color.from_hsv(fmod(hue + 0.5, 1.0), 0.7, 0.6)
	# Real art when available: everyone uses the premade NPC sheets (full
	# idle+walk animation). Sheets 7 & 8 are reserved for main/ceo so the
	# leadership stays visually distinct. (Custom compositor remains for
	# when the full layer pack with walk frames is available.)
	s.agent_name = id.capitalize()
	if roster.has(id):
		# Registry identity wins: the owner picked this face/role/name.
		s.agent_name = roster[id].name
		s.agent_role = roster[id].role
		s.npc_index = roster[id].avatar
	elif id == "main":
		s.npc_index = 7   # the beret — director look
		s.agent_role = "Director"
	elif id == "ceo":
		s.agent_role = "Chairman"
	if id == "main":
		s.rank = "lead"
	elif id == "ceo":
		s.rank = "ceo"
	elif not roster.has(id):
		# Hash-rolled look ONLY for unregistered ids — it must never stomp
		# the face/role the owner picked in the registry.
		s.npc_index = [1, 2, 3, 4, 5, 6, 9, 10, 11, 12][h % 10]
		s.agent_role = ["Researcher", "Engineer", "Designer", "Analyst",
			"Operator", "Specialist"][h % 6]
	s.pixel_size = 0.07
	s.billboard = StandardMaterial3D.BILLBOARD_FIXED_Y
	s.shaded = true
	s.alpha_cut = SpriteBase3D.ALPHA_CUT_DISCARD
	s.texture_filter = BaseMaterial3D.TEXTURE_FILTER_NEAREST
	return s

# ---------------------------------------------------------------- flavor

func _spawn_ceo() -> void:
	ceo = _make_char("ceo")
	ceo.suit_color = Color8(64, 52, 26)   # gold-brown suit (procedural fallback)
	ceo.hair_color = Color8(70, 70, 74)
	ceo.npc_index = 8  # straw hat + suspenders — reserved for the chairman
	ceo.position = world.WP["pace_a"]
	get_parent().add_child(ceo)
	ceo.set_state("idle")
	_ceo_loop()
	_intro_focus()

## Opening shot: glide the camera to the CEO when the office boots.
func _intro_focus() -> void:
	await get_tree().create_timer(1.0).timeout
	if not is_instance_valid(ceo): return
	var rig := get_node_or_null("../CameraRig")
	if rig and rig.has_method("focus_on"):
		rig.focus_on(ceo, 9.0)
		# keep ambient close-ups quiet until the intro has fully eased back
		_focus_cd = Time.get_ticks_msec() / 1000.0 + 60.0

func _ceo_loop() -> void:
	# The boss inspects the WHOLE office — but spends most time on the
	# executive floor, and stands still while giving orders or receiving
	# a report.
	while is_instance_valid(ceo):
		await get_tree().create_timer(randf_range(6.0, 11.0)).timeout
		if not is_instance_valid(ceo):
			return
		if Time.get_ticks_msec() / 1000.0 < ceo_hold_until:
			continue
		# The boss stays on the executive floor almost all the time, and only
		# once in a while (~12%) wanders off to peek at another room.
		if randf() < 0.88:
			_walk(ceo, ["pace_a", "pace_b", "exec_c", "ceo_desk"].pick_random())
		else:
			_walk(ceo, ["lobby_c", "cafe_c", "rec_c", "ops_c", "meeting_c",
				"sec_c", "server_c", "cafe_s1"].pick_random())

## The Director doesn't hover over the CEO all day: when idle he makes the
## rounds — recreation room, cafe, a look over the ops floor, server room.
func _main_wander_loop() -> void:
	var rounds: Array[String] = ["rec_c", "cafe_c", "ops_c", "lobby_c",
		"server_c", "meeting_c", "rec_s2", "cafe_s1", "dormx_c"]
	while is_inside_tree():
		await get_tree().create_timer(randf_range(11.0, 22.0)).timeout
		if not agents.has("main"):
			continue
		var a: Dictionary = agents["main"]
		if a.state != "idle" or not is_instance_valid(a.node):
			continue
		# Shino roams the whole office, but he loves two things: dropping by the
		# CEO, and hanging out with the staff. ~30% visit the boss, ~30% go play
		# with an idle teammate, the rest is a general round of the rooms.
		var r := randf()
		if r < 0.30 and is_instance_valid(ceo):
			_walk(a.node, ["exec_c", "ceo_desk", "pace_b"].pick_random())
			a.node.set_status("แวะหา CEO 👑")
			_clear_status_later(a, 5.0)
		elif r < 0.60:
			var mates: Array = []
			for id in agents:
				var m: Dictionary = agents[id]
				if id != "main" and id != "ceo" and m.state == "idle" and is_instance_valid(m.node):
					mates.append(m)
			if mates.is_empty():
				_walk(a.node, rounds.pick_random())
			else:
				var mate: Dictionary = mates.pick_random()
				a.node.walk_to(world.path_between(a.node.position,
					mate.node.position + Vector3(0.6, 0, 0.35)))
				a.node.set_status("คุยกับทีม 💬")
				_clear_status_later(a, 6.0)
		else:
			_walk(a.node, rounds.pick_random())

# ---------------------------------------------------------------- supervision
# The Director keeps tabs on delegated work in person: he shadows the first
# delegate; extra assignments get a translucent supervisor clone each. Once
# the delegate settles into work ("thinking" done), the shadow lets go —
# and when the work is finished, the delegate walks the result back to him.

## Keep `follower` glued to `target` without EVER cutting walls: steer at
## close range, A* re-route when far. Runs until `until.call()` is true.
func _tail_loop(follower: Sprite3D, target: Node3D, offset: Vector3, until: Callable) -> void:
	var last_tp := Vector3(INF, INF, INF)
	while is_instance_valid(follower) and is_instance_valid(target) and not until.call():
		var tp: Vector3 = target.position + offset
		var dist := follower.position.distance_to(tp)
		if dist > 3.2:
			# Re-path ONLY when the target actually moved. Re-routing toward a
			# standing target every tick makes A* re-pick the nearest node (often
			# one just BEHIND the walker), so the Director kept jinking backward
			# the whole way over. One clean path to a stationary boss = no jitter.
			if (last_tp - tp).length() > 0.6:
				last_tp = tp
				follower.unfollow()
				follower.walk_to(world.path_between(follower.position, tp))
		elif follower.follow_node != target:
			follower.follow(target, offset)
		await get_tree().create_timer(0.6).timeout
	if is_instance_valid(follower) and follower.follow_node == target:
		follower.unfollow()

## The Director tails the CEO for the whole conversation, then heads to
## his own workstation if he still has work.
func _tail_ceo(a: Dictionary) -> void:
	var a_ref := a
	await _tail_loop(a.node, ceo, Vector3(1.1, 0, 0.6), func() -> bool:
		return Time.get_ticks_msec() / 1000.0 >= float(a_ref.get("hold_at_ceo", 0.0)) \
			or a_ref.state != "working")
	if is_instance_valid(a.node) and a.state == "working":
		_walk(a.node, a.desk if a.desk != "" else "lead_desk")

## Shadow a delegate while they receive the work — until they settle into
## working (thinking done) for a few seconds. Then let go.
func _supervise(tgt: String, follower: Sprite3D) -> void:
	await get_tree().create_timer(4.0).timeout  # let the hand-over walk start
	if not supervising.has(tgt) or not agents.has(tgt) \
			or not is_instance_valid(follower):
		supervising.erase(tgt)
		return
	var settled := {"t": 0.0}
	var is_main: bool = follower == agents.get("main", {}).get("node")
	await _tail_loop(follower, agents[tgt].node, Vector3(-1.05, 0, 0.6), func() -> bool:
		if not supervising.has(tgt) or not agents.has(tgt):
			return true
		if is_main and not agents["main"].tasks.is_empty():
			return true  # his own work calls
		if agents[tgt].state == "working":
			if settled.t == 0.0:
				settled.t = Time.get_ticks_msec() / 1000.0
			return Time.get_ticks_msec() / 1000.0 - settled.t > 6.0
		settled.t = 0.0
		return false)
	# Thinking done (or duty calls): the shadow lets go.
	var sup: Dictionary = supervising.get(tgt, {})
	supervising.erase(tgt)
	var g: Sprite3D = sup.get("ghost")
	if g != null and is_instance_valid(g):
		_dissolve_supervisor(g)
	elif is_main and agents.has("main") and agents["main"].tasks.is_empty():
		_finish(agents["main"], "มอบหมายแล้ว ✓")

## Too busy for the meeting? แยกร่างเข้าประชุมแทน — a translucent stand-in
## walks to the table while the real one keeps working.
func _spawn_meeting_ghost(id: String, seat: String) -> void:
	if meeting_ghosts.has(id) or not agents.has(id):
		return
	var pnode: Sprite3D = agents[id].node
	var g := _make_char(id)
	g.npc_index = pnode.npc_index
	g.suit_color = pnode.suit_color
	g.hair_color = pnode.hair_color
	g.skin_color = pnode.skin_color
	g.rank = "ghost"
	g.agent_name = str(pnode.agent_name) + " · ประชุม"
	g.agent_role = "stand-in"
	get_parent().add_child(g)
	g.set_ghost()
	g.position = pnode.position + Vector3(0.3, 0, 0.25)
	g.set_state("meeting")
	g.set_status("ประชุมแทนตัวจริง 🗣")
	meeting_ghosts[id] = g
	Burst.spawn(world, pnode.position, 0.65)
	Sfx.play("split")
	_walk(g, seat)

func _dissolve_meeting_ghost(id: String) -> void:
	var g: Sprite3D = meeting_ghosts.get(id)
	meeting_ghosts.erase(id)
	if g == null or not is_instance_valid(g):
		return
	var dur := 0.0
	if agents.has(id) and is_instance_valid(agents[id].node):
		dur = g.walk_to(world.path_between(g.position, agents[id].node.position))
	await get_tree().create_timer(maxf(dur, 0.1) + 0.3).timeout
	if is_instance_valid(g):
		Burst.spawn(world, g.position, 0.65)
		Sfx.play("whoosh")
		g.ghost_dissolve()

func _dissolve_supervisor(g: Sprite3D) -> void:
	g.unfollow()
	Sfx.play("whoosh")
	var dur := 0.0
	if agents.has("main") and is_instance_valid(agents["main"].node):
		dur = g.walk_to(world.path_between(g.position, agents["main"].node.position))
	await get_tree().create_timer(maxf(dur, 0.1) + 0.3).timeout
	if is_instance_valid(g):
		Burst.spawn(world, g.position, 0.65)
		Sfx.play("whoosh")
		g.ghost_dissolve()

## A translucent clone of the Director splits off to watch one delegate.
func _spawn_supervisor(tgt: String) -> void:
	if not agents.has("main") or not is_instance_valid(agents["main"].node):
		return
	var mnode: Sprite3D = agents["main"].node
	var g := _make_char("main")
	g.npc_index = mnode.npc_index
	g.suit_color = mnode.suit_color
	g.hair_color = mnode.hair_color
	g.skin_color = mnode.skin_color
	g.rank = "ghost"
	g.agent_name = str(mnode.agent_name) + " · คุมงาน"
	g.agent_role = "supervisor"
	get_parent().add_child(g)
	g.set_ghost()
	g.position = mnode.position + Vector3(0.3, 0, 0.25)
	g.set_status("คุมงาน → " + str(agents[tgt].node.agent_name) + " 👀")
	Burst.spawn(world, mnode.position)
	Sfx.play("split")
	supervising[tgt] = {"ghost": g}
	_supervise(tgt, g)

## A delegate finished while still shadowed (fast job): clean up the tail.
func _end_supervision(id: String) -> void:
	if not supervising.has(id):
		return
	var sup: Dictionary = supervising[id]
	supervising.erase(id)
	var g: Sprite3D = sup.get("ghost")
	if g != null and is_instance_valid(g):
		_dissolve_supervisor(g)
	elif agents.has("main") and is_instance_valid(agents["main"].node):
		agents["main"].node.unfollow()

# ---------------------------------------------------------------- idle life
# Idle agents actually LIVE in the office: watch TV (it really turns on),
# kick the football, play with the cat, chat with a colleague. Activities
# only dress the idle state — a new task interrupts them cleanly.

func _idle_life_loop() -> void:
	while is_inside_tree():
		await get_tree().create_timer(randf_range(9.0, 16.0)).timeout
		var pool: Array = []
		for id in agents:
			var a: Dictionary = agents[id]
			if a.state == "idle" and id != "ceo" and is_instance_valid(a.node):
				pool.append(a)
		if pool.is_empty():
			continue
		var a: Dictionary = pool.pick_random()
		# Weighted so the CAFE gets as much love as the REC room, with the odd
		# wander to the server/meeting rooms (rare). Beds are handled by naps.
		var r := randf()
		if r < 0.18:
			_act_tv(a)             # rec
		elif r < 0.28:
			_act_ball(a)           # rec
		elif r < 0.38:
			_act_pet(a)            # rec
		elif r < 0.76:
			_act_cafe(a)           # cafe — equal weight to the rec activities
		elif r < 0.92:
			_act_chat(a, pool)     # chat with a colleague (anywhere)
		else:
			_act_explore(a)        # a rare peek at the server / meeting room

func _act_tv(a: Dictionary) -> void:
	a.node.set_status("ดูทีวี 📺")
	var spot := Vector3(-7.25, 0.86, randf_range(7.6, 9.2))
	var d: float = a.node.walk_to(world.path_to(a.node.position, "rec_s1") + [spot])
	await get_tree().create_timer(d).timeout
	if a.state != "idle":
		return
	_tv_watchers += 1
	world.tv_set(true)
	await get_tree().create_timer(randf_range(14.0, 26.0)).timeout
	_tv_watchers -= 1
	if _tv_watchers <= 0:
		world.tv_set(false)  # nobody watching — the office saves power
	if a.state == "idle":
		a.node.set_status("")

func _act_ball(a: Dictionary) -> void:
	if not is_instance_valid(world.ball):
		return
	a.node.set_status("เตะบอล ⚽")
	var bp: Vector3 = world.ball.position
	var d: float = a.node.walk_to(world.path_to(a.node.position, "rec_s2") +
		[Vector3(bp.x - 0.45, 0.86, bp.z + 0.3)])
	await get_tree().create_timer(d + 0.2).timeout
	if a.state != "idle":
		return
	if world.ball.has_method("kick_now"):
		world.ball.kick_now()
	Fx.spawn(a.node, "sparkle", Vector3(0, 0.4, 0), 0.03)
	_maybe_focus(a.node, 0.6, 6.0)
	_clear_status_later(a, 6.0)

func _act_pet(a: Dictionary) -> void:
	if not is_instance_valid(world.pet):
		return
	a.node.set_status("เล่นกับแมว 🐱")
	var pp: Vector3 = world.pet.position
	var d: float = a.node.walk_to(world.path_to(a.node.position, "rec_c") +
		[Vector3(pp.x + 0.7, 0.86, pp.z + 0.35)])
	await get_tree().create_timer(d).timeout
	if a.state != "idle":
		return
	if world.pet.has_method("attend"):
		world.pet.attend(a.node.position)
	Fx.spawn(a.node, "heart", Vector3(0, 1.2, 0))
	Fx.spawn(world.pet, "heart", Vector3(0, 0.5, 0), 0.02)
	_maybe_focus(a.node, 0.7, 6.0)
	_clear_status_later(a, 7.0)

func _act_chat(a: Dictionary, pool: Array) -> void:
	var others := pool.filter(func(o): return o.id != a.id and o.state == "idle")
	if others.is_empty():
		return
	var b: Dictionary = others.pick_random()
	a.node.set_status("คุยเล่น 💬")
	b.node.set_status("คุยเล่น 💬")
	var d: float = a.node.walk_to(world.path_between(a.node.position,
		b.node.position + Vector3(0.6, 0, 0.35)))
	await get_tree().create_timer(d + 0.3).timeout
	if a.state == "idle" and is_instance_valid(a.node):
		_fx(a, "music")
		_maybe_focus(a.node, 0.55, 6.0)
	_clear_status_later(a, 6.0)
	_clear_status_later(b, 6.0)

## Hang out in the cafeteria — given equal weight to the rec room so idle
## agents don't all pile into one corner.
func _act_cafe(a: Dictionary) -> void:
	a.node.set_status("พักดื่มกาแฟ ☕")
	var seat: String = ["cafe_s1", "cafe_s2", "cafe_c"].pick_random()
	var d: float = _walk(a.node, seat)
	await get_tree().create_timer(d + randf_range(8.0, 16.0)).timeout
	if a.state == "idle":
		a.node.set_status("")

## Once in a while an agent strolls off to the server room or the meeting room
## for a change of scene — deliberately rare so those rooms stay special.
func _act_explore(a: Dictionary) -> void:
	var spot: String = "server_c" if randf() < 0.5 else "meeting_c"
	a.node.set_status("เปลี่ยนบรรยากาศ 🚶")
	var d: float = _walk(a.node, spot)
	await get_tree().create_timer(d + randf_range(6.0, 12.0)).timeout
	if a.state == "idle":
		a.node.set_status("")

# ---------------------------------------------------------------- naps
# No orders for 3 minutes → an agent may decide to take a bunk nap (beds
# are limited!) or keep idling. Any event wakes them right back up.

func _nap_loop() -> void:
	while is_inside_tree():
		await get_tree().create_timer(25.0).timeout
		var now := Time.get_ticks_msec() / 1000.0
		for id in agents:
			if id in ["main", "ceo"]:
				continue
			var a: Dictionary = agents[id]
			if a.state != "idle" or not is_instance_valid(a.node):
				continue
			if now - float(a.get("idle_since", now)) < 180.0:
				continue
			if randf() < 0.5 and bed_pool.size() > 0:
				_take_nap(a)
			else:
				a["idle_since"] = now  # stays up — re-rolls in 3 minutes

func _take_nap(a: Dictionary) -> void:
	a.bed = bed_pool.pop_front()
	_set_state(a, "resting")
	a.node.set_status("งีบพักผ่อน 💤")
	_walk(a.node, a.bed)
	await get_tree().create_timer(randf_range(60.0, 180.0)).timeout
	# Wake on the alarm only if nothing else woke them first.
	if a.state == "resting":
		if a.bed != "":
			bed_pool.append(a.bed)
			a.bed = ""
		_set_state(a, "idle")
		a.node.set_status("ตื่นแล้ว ☀")
		_walk(a.node, _next_seat())
		_clear_status_later(a, 4.0)

func _pulse_security() -> void:
	var l: OmniLight3D = world.sec_light
	var tw := create_tween()
	for i in 3:
		tw.tween_property(l, "light_energy", 5.0, 0.4)
		tw.tween_property(l, "light_energy", 1.2, 0.4)
