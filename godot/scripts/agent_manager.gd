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
var ceo: Sprite3D

func _ready() -> void:
	_spawn_ceo.call_deferred()

func set_connected(connected: bool) -> void:
	world.set_totem(connected)

# ---------------------------------------------------------------- events

func handle(evt: Dictionary) -> void:
	var id := str(evt.get("agent", "agent"))
	var type := str(evt.get("type", ""))
	var task := str(evt.get("task", id))  # agent-as-task fallback (tier-1 adapters)
	if type == "agent.offline":
		_despawn(id)
		return
	var a: Dictionary = _ensure(id)
	match type:
		"agent.online":
			pass  # _ensure already spawned them
		"task.started":
			a.tasks[task] = true
			_to_desk(a)
			world.board_set(task, "running", id)
		"task.progress":
			if a.state != "working":
				a.tasks[task] = true
				_to_desk(a)
				world.board_set(task, "running", id)
			a.node.set_status(str(evt.get("tool", "working…")))
		"task.completed":
			a.tasks.erase(task)
			world.board_set(task, "done", id)
			_board_clear_later(task)
			if a.tasks.is_empty():
				_finish(a, "done ✓")
		"task.failed":
			a.tasks.erase(task)
			world.board_set(task, "failed", id)
			_board_clear_later(task)
			if a.tasks.is_empty():
				_finish(a, "failed ✗")
		"perm.requested":
			a.state = "blocked"
			a.node.set_status("needs approval ⚠")
			_walk(a.node, "sec_window")
			_pulse_security()
			world.board_set(task, "blocked", id)
		"perm.approved":
			a.state = "working"
			a.node.set_status("approved ✓")
			if a.desk != "":
				_walk(a.node, a.desk)
			world.board_set(task, "running", id)
		"perm.denied":
			a.tasks.erase(task)
			world.board_set(task, "failed", id)
			_board_clear_later(task)
			if a.tasks.is_empty():
				_finish(a, "denied ✗")
		"chat.message":
			# Speech bubble: first line of what the agent actually said.
			var text := str(evt.get("text", "")).split("\n")[0]
			a.node.set_status("💬 " + text.left(28))

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

func _despawn(id: String) -> void:
	if not agents.has(id):
		return
	var a: Dictionary = agents[id]
	_release_desk(a)
	for t in a.tasks:
		world.board_set(t, "none")
	agents.erase(id)
	a.node.set_status("offline 💤")
	var dur: float = _walk(a.node, "spawn")
	await get_tree().create_timer(dur + 0.5).timeout
	a.node.queue_free()

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
	var h := absi(id.hash())
	var hue := float(h % 360) / 360.0
	s.suit_color = Color.from_hsv(hue, 0.5, 0.45)
	s.hair_color = Color.from_hsv(fmod(hue + 0.35, 1.0), 0.45, 0.22)
	s.skin_color = [Color8(236, 188, 152), Color8(208, 152, 110), Color8(140, 95, 66)][(h / 360) % 3]
	s.tie_color = Color.from_hsv(fmod(hue + 0.5, 1.0), 0.7, 0.6)
	# Real art when available: main = composited custom character (keeps its
	# identity tints), everyone else = one of the 12 premade NPC sheets.
	if id == "main":
		s.npc_index = 0
		s.hair_color = Color(0.9, 0.75, 0.4)   # golden hair for the boss
		s.suit_color = Color(0.85, 0.8, 0.75)
	else:
		s.npc_index = 1 + (h % 12)
	s.pixel_size = 0.07
	s.billboard = StandardMaterial3D.BILLBOARD_FIXED_Y
	s.shaded = true
	s.alpha_cut = SpriteBase3D.ALPHA_CUT_DISCARD
	s.texture_filter = BaseMaterial3D.TEXTURE_FILTER_NEAREST
	return s

# ---------------------------------------------------------------- flavor

func _spawn_ceo() -> void:
	ceo = _make_char("ceo")
	ceo.suit_color = Color8(64, 52, 26)   # gold-brown suit
	ceo.hair_color = Color8(70, 70, 74)
	ceo.npc_index = 0  # composited custom character (idle-only is fine for pacing)
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
