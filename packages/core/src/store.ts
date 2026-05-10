import type {
  Activity,
  Dependency,
  Migration,
  Project,
  Tag,
  Task,
  TaskTag,
  Track,
  TrackAssignment
} from "./types.js";

export interface ProjectRepository {
  list(): Promise<Project[]>;
  get(id: string): Promise<Project | null>;
  create(project: Project): Promise<void>;
  update(project: Project): Promise<void>;
}

export interface TaskRepository {
  list(projectId?: string): Promise<Task[]>;
  get(projectId: string, id: string): Promise<Task | null>;
  create(task: Task): Promise<void>;
  update(task: Task): Promise<void>;
  delete(projectId: string, id: string): Promise<void>;
}

export interface DependencyRepository {
  list(projectId?: string): Promise<Dependency[]>;
  listForTask(projectId: string, taskId: string): Promise<Dependency[]>;
  listDependents(projectId: string, dependsOnTaskId: string): Promise<Dependency[]>;
  add(dependency: Dependency): Promise<void>;
  remove(projectId: string, taskId: string, dependsOnTaskId: string): Promise<void>;
  replaceForTask(projectId: string, taskId: string, dependencies: Dependency[]): Promise<void>;
}

export interface TagRepository {
  list(projectId?: string): Promise<Tag[]>;
  get(projectId: string, id: string): Promise<Tag | null>;
  findByName(projectId: string, name: string): Promise<Tag | null>;
  create(tag: Tag): Promise<void>;
  update(tag: Tag): Promise<void>;
  listTaskTags(projectId?: string): Promise<TaskTag[]>;
  addTaskTag(taskTag: TaskTag): Promise<void>;
  removeTaskTag(projectId: string, taskId: string, tagId: string): Promise<void>;
}

export interface TrackRepository {
  list(projectId?: string): Promise<Track[]>;
  get(projectId: string, id: string): Promise<Track | null>;
  findByActor(projectId: string, machine: string, actor: string): Promise<Track | null>;
  create(track: Track): Promise<void>;
  update(track: Track): Promise<void>;
  listAssignments(projectId?: string): Promise<TrackAssignment[]>;
  assign(assignment: TrackAssignment): Promise<void>;
  unassign(projectId: string, trackId: string, taskId: string): Promise<void>;
  updateAssignment(assignment: TrackAssignment): Promise<void>;
}

export interface ActivityRepository {
  list(projectId?: string | null, limit?: number): Promise<Activity[]>;
  append(activity: Activity): Promise<void>;
}

export interface MigrationRepository {
  list(): Promise<Migration[]>;
  markApplied(migration: Migration): Promise<void>;
}

export interface RepositorySet {
  projects: ProjectRepository;
  tasks: TaskRepository;
  dependencies: DependencyRepository;
  tags: TagRepository;
  tracks: TrackRepository;
  activity: ActivityRepository;
  migrations: MigrationRepository;
}

export interface AppStore extends RepositorySet {
  transaction<T>(fn: (repos: RepositorySet) => Promise<T>): Promise<T>;
  close?(): Promise<void> | void;
}

export interface StoreFactoryOptions {
  databasePath?: string;
}
