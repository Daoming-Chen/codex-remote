export type AgentKind = 'codex' | 'antigravity';
export interface SessionRef {
  agent: AgentKind;
  sessionId: string;
  cwd: string;
  projectId?: string | null;
  title?: string;
}
export type DispatchStatus = 'awaiting_confirm' | 'queued' | 'running' | 'waiting_approval'
  | 'returning' | 'done' | 'stopped' | 'failed' | 'rejected';
export interface DispatchPolicy {
  mode: 'auto' | 'confirm';
  maxHops: number;
  singleWriterLock: boolean;
}
export interface DispatchRequest {
  from: SessionRef;
  to: Omit<SessionRef, 'sessionId'> & {sessionId?: string | null};
  objective: string;
  prompt: string;
  autoReturn?: boolean;
  parentDispatchId?: string | null;
}
export interface DispatchRecord extends Omit<DispatchRequest, 'autoReturn'> {
  id: string;
  chainId: string;
  hop: number;
  autoReturn: boolean;
  status: DispatchStatus;
  targetJobId?: string;
  returnJobId?: string;
  returnStarted?: boolean;
  summary?: string;
  cancelRequested?: boolean;
  dispatchNotice?: string;
  approval?: {agent: AgentKind; jobId: string; token: string; title: string; detail: string; canAnswer: boolean} | null;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}
export function isAgent(value: unknown): value is AgentKind {
  return value === 'codex' || value === 'antigravity';
}
export function validSessionId(agent: AgentKind, value: unknown): value is string {
  return typeof value === 'string' && (agent === 'codex'
    ? /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
    : /^[A-Za-z0-9_-]{1,256}$/).test(value);
}
export function validPolicy(value: DispatchPolicy): boolean {
  return ['confirm','auto'].includes(value.mode) && Number.isSafeInteger(value.maxHops)
    && value.maxHops >= 1 && value.maxHops <= 32 && typeof value.singleWriterLock === 'boolean';
}


export interface RuntimeTool {
  type: string;
  title?: string;
  command?: string;
  status?: string;
  exitCode?: number;
  locations?: string[];
  changes?: {path: string}[];
}
export interface RuntimeTurn {
  cwd?: string;
  selection?: {projectId?: string | null};
  progress?: {items?: RuntimeTool[]};
  rows?: {items?: RuntimeTool[]}[];
  id: string;
  status: string;
  session?: string | null;
  thread?: string | null;
  answer?: string;
  text?: string;
  error?: string;
  approval?: Pick<NonNullable<DispatchRecord['approval']>, 'token' | 'title' | 'detail'>
    & {canAnswer?: boolean} | null;
}
export interface AgentRuntimeAdapter {
  sessions(target: Pick<SessionRef,'cwd'>): Promise<SessionRef[]>;
  startTurn(input: Omit<SessionRef,'sessionId'> & {sessionId?: string | null; id: string; prompt: string;
    mode?: string; model?: string; effort?: string; serviceTier?: string; sandbox?: string; approvalPolicy?: string;
    queue: boolean}): Promise<unknown>;
  getTurnStatus(id: string): Promise<RuntimeTurn>;
  cancelTurn(id: string, job: RuntimeTurn): Promise<unknown>;
  answerApproval(id: string, token: string, decision: 'allow-once' | 'reject-once'): Promise<unknown>;
}
