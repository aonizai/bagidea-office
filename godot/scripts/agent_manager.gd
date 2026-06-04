extends Node
## Maps agent IDs from daemon events to characters in the world, and
## choreographs them: desks for work, cafeteria for idle, security for
## approvals. OEP v0.2: events may carry a `task` id, so one agent can own
## several missions at once (board cards are per-task, body is per-agent).

const AgentScript := preload("res://scripts/agent_sprite.gd")

@onready var world: Node3D = get_node("../World")

var agents := {}  # id -> {node, state, desk, id, tasks: {task_id: true}}
var desk_pool: Array[String] = ["desk1", "desk2", "desk3", "desk4"]
var seat_cycle: Array[String] = ["cafe_s1", "cafe_s2", "cafe_c"]
var meeting_cycle: Array[String] = ["m_s1", "m_s2", "m_s3", "m_s4"]
var bed_pool: Array[String] = ["bed1", "bed2"]
var ceo: Sprite3D

func _ready() -> void:
	_spawn_ceo.call_deferred()

func set_connected(connected: bool) -> void:
	world.set_totem(connected)

# ---------------------------------------------------------------- events

func handle(evt: Dictionary) -> void:
	var type := str(evt.get("type", ""))
	# Replay Theater: the daemon re-broadcasts journal slices time-compressed.
	# Characters act them out, but the mission board stays in the present.
	if type == "theater.started":
		world.set_theater(true)
		return
	if type == "theater.ended":
		world.set_theater(false)
		return
	var theatrical: bool = evt.get("theater", false)

	# Collaboration events may target several agents at once.
	if type in ["collab.started", "collab.ended"] and evt.has("agents"):
		for member in evt.agents:
			var sub := evt.duplicate()
			sub.erase("agents")
			sub["agent"] = str(member)
			handle(sub)
		return

	var id := str(evt.get("agent", "agent"))
	var task := str(evt.get("task", id))  # agent-as-task fallback (tier-1 adapters)
	if type == "agent.offline":
		_to_dorm(id)
		return
	var a: Dictionary = _ensure(id)
	if a.state == "offline":
		a.state = "idle"
		a.node.set_status("good morning ☀")
		_clear_status_later(a, 3.0)
	match type:
		"agent.online":
			pass  # _ensure already spawned them
		"task.started":
			a.tasks[task] = true
			_to_desk(a)
			if not theatrical:
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
			if not theatrical:
				world.board_set(task, "done", id)
				_board_clear_later(task)
			if a.tasks.is_empty():
				_finish(a, "done ✓")
		"task.failed":
			a.tasks.erase(task)
			if not theatrical:
				world.board_set(task, "failed", id)
				_board_clear_later(task)
			if a.tasks.is_empty():
				_finish(a, "failed ✗")
		"perm.requested":
			a.state = "blocked"
			a.node.set_status("needs approval ⚠")
			_walk(a.node, "sec_window")
			_pulse_security()
			if not theatrical:
				world.board_set(task, "blocked", id)
		"perm.approved":
			a.state = "working"
			a.node.set_status("approved ✓")
			if a.desk != "":
				_walk(a.node, a.desk)
			if not theatrical:
				world.board_set(task, "running", id)
		"perm.denied":
			a.tasks.erase(task)
			if not theatrical:
				world.board_set(task, "failed", id)
				_board_clear_later(task)
			if a.tasks.is_empty():
				_finish(a, "denied ✗")
		"chat.message":
			# Speech bubble: first line of what the agent actually said.
			var text := str(evt.get("text", "")).split("\n")[0]
			a.node.set_status("💬 " + text.left(28))
			# In a meeting, words land on the whiteboard (truth, not theater).
			if a.state == "meeting":
				world.whiteboard_add(id, text)
		"collab.started":
			# Agents physically gather at the meeting table (design doc 4.7).
			if a.state != "meeting":
				world.whiteboard_reset("◤ MEETING · " + task)
			a.state = "meeting"
			a.node.set_status("meeting 🗣")
			var seat: String = meeting_cycle.pop_front()
			meeting_cycle.append(seat)
			_walk(a.node, seat)
		"collab.ended":
			if a.state == "meeting":
				world.whiteboard_add("", "— adjourned —")
			if a.tasks.is_empty():
				_finish(a, "done ✓")
			else:
				a.state = "working"
				a.node.set_status("working…")
				if a.desk != "":
					_walk(a.node, a.desk)

# ---------------------------------------------------------------- agents

func _ensure(id: String) -> Dictionary:
	if agents.has(id):
		return agents[id]
	# New hire: walk in through the lobby front door.
	var node := _make_char(id)
	node.position = world.WP["spawn"]
	get_parent().add_child(node)
	node.set_status(id)
	var a := {"node": node, "state": "idle", "desk": "", "id": id, "tasks": {}}
	agents[id] = a
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
	a.state = "offline"
	a.node.set_status("offline 💤")
	var bed: String = bed_pool.pop_front() if bed_pool.size() > 0 else "dorm_c"
	if bed != "dorm_c":
		bed_pool.append(bed)  # cycle: bunks are shared
	_walk(a.node, bed)

func _to_desk(a: Dictionary) -> void:
	if a.desk == "":
		if a.id == "main":
			a.desk = "ceo_desk"  # the main agent runs the company from exec
		else:
			a.desk = desk_pool.pop_front() if desk_pool.size() > 0 else "ops_c"
	a.state = "working"
	a.node.set_status("thinking…")
	_walk(a.node, a.desk)

func _finish(a: Dictionary, label: String) -> void:
	a.node.set_status(label)
	_release_desk(a)
	a.state = "idle"
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

func _board_clear_later(id: String, delay := 10.0) -> void:
	await get_tree().create_timer(delay).timeout
	world.board_clear_if_finished(id)

func _clear_status_later(a: Dictionary, delay: float) -> void:
	await get_tree().create_timer(delay).timeout
	if a.state == "idle":
		a.node.set_status("")

func _walk(node: Sprite3D, target: String) -> float:
	var path: Array = world.path_to(node.position, target)
	# Tiny jitter on shared idle spots so agents don't stack pixel-perfect.
	if target.begins_with("cafe"):
		path[path.size() - 1] += Vector3(randf_range(-0.35, 0.35), 0, randf_range(-0.35, 0.35))
	return node.walk_to(path)

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
	if id == "main":
		s.npc_index = 7   # the beret — director look
		s.agent_role = "Director"
	elif id == "ceo":
		s.agent_role = "Chairman"
	else:
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
	_ceo_loop()

func _ceo_loop() -> void:
	# Light flavor behavior: the CEO paces around the executive office.
	while is_instance_valid(ceo):
		await get_tree().create_timer(randf_range(5.0, 9.0)).timeout
		if not is_instance_valid(ceo):
			return
		_walk(ceo, ["pace_a", "pace_b", "exec_c"].pick_random())

func _pulse_security() -> void:
	var l: OmniLight3D = world.sec_light
	var tw := create_tween()
	for i in 3:
		tw.tween_property(l, "light_energy", 5.0, 0.4)
		tw.tween_property(l, "light_energy", 1.2, 0.4)
