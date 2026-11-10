import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { Agent, AgentRequest, AgentRun, BranchPlace, Daily, DailyDraft, Direction, JiraHealth, Link, LinkKind, Note, NoteFile, NoteUrl, Profile, QuickLink, QuickLinkGroup, Status, SummaryItem, Terminal, Ticket, Todo, WorkEvent, WorklogState } from '@worklog/model';
import type { Observable } from 'rxjs';

export interface NewDirection {
  title: string;
  tickets?: string[];
  status?: Status;
  waitingFor?: string;
}

export interface DirectionPatch {
  title?: string;
  waitingFor?: string | null;
}

export interface StatusChange {
  status: Status;
  index?: number;
  waitingFor?: string | null;
}

export interface NewLink {
  url: string;
  title?: string;
  kind?: LinkKind;
  description?: string;
}

export interface NoteBody {
  title?: string;
  body?: string;
  directionIds?: string[];
  files?: NoteFile[];
  urls?: NoteUrl[];
}

export interface NewTodo {
  text: string;
  directionId?: string;
  requestedBy?: string;
  due?: string;
}

export interface TodoPatch {
  text?: string;
  directionId?: string | null;
  requestedBy?: string | null;
  due?: string | null;
  done?: boolean;
}

export interface NewQuickLink {
  groupTitle: string;
  title: string;
  url: string;
}

/** applied is false when there was nothing to undo or redo */
export interface HistoryAnswer {
  applied: boolean;
}

export interface DailyText {
  periodStart: string;
  text: string | null;
}

export interface HeldDaily {
  periodStart: string;
  text: string;
}

function directionUrl(id: string): string {
  return `/api/directions/${encodeURIComponent(id)}`;
}

function todoUrl(id: string): string {
  return `/api/todos/${encodeURIComponent(id)}`;
}

@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly http = inject(HttpClient);

  getState(): Observable<WorklogState> {
    return this.http.get<WorklogState>('/api/state');
  }

  getProfile(): Observable<{ profile: Profile | null }> {
    return this.http.get<{ profile: Profile | null }>('/api/profile');
  }

  createDirection(body: NewDirection): Observable<Direction> {
    return this.http.post<Direction>('/api/directions', body);
  }

  patchDirection(id: string, body: DirectionPatch): Observable<Direction> {
    return this.http.patch<Direction>(directionUrl(id), body);
  }

  setStatus(id: string, body: StatusChange): Observable<Direction> {
    return this.http.post<Direction>(`${directionUrl(id)}/status`, body);
  }

  clearMark(id: string): Observable<Direction> {
    return this.http.post<Direction>(`${directionUrl(id)}/unmark`, {});
  }

  deleteDirection(id: string): Observable<void> {
    return this.http.delete<void>(directionUrl(id));
  }

  addEvent(id: string, text: string): Observable<WorkEvent> {
    return this.http.post<WorkEvent>(`${directionUrl(id)}/events`, { text });
  }

  addTicket(id: string, key: string): Observable<Ticket> {
    return this.http.post<Ticket>(`${directionUrl(id)}/tickets`, { key });
  }

  removeTicket(id: string, key: string): Observable<void> {
    return this.http.delete<void>(`${directionUrl(id)}/tickets/${encodeURIComponent(key)}`);
  }

  addLink(id: string, body: NewLink): Observable<Link> {
    return this.http.post<Link>(`${directionUrl(id)}/links`, body);
  }

  setLinkDescription(id: string, url: string, description: string | null): Observable<Link> {
    return this.http.patch<Link>(`${directionUrl(id)}/links`, { url, description });
  }

  setQuickLinkDescription(groupId: string, url: string, description: string | null): Observable<QuickLink> {
    return this.http.patch<QuickLink>(`/api/link-groups/${encodeURIComponent(groupId)}/links`, { url, description });
  }

  createNote(body: NoteBody & { title: string }): Observable<Note> {
    return this.http.post<Note>('/api/notes', body);
  }

  patchNote(id: string, body: NoteBody): Observable<Note> {
    return this.http.patch<Note>(`/api/notes/${encodeURIComponent(id)}`, body);
  }

  deleteNote(id: string): Observable<void> {
    return this.http.delete<void>(`/api/notes/${encodeURIComponent(id)}`);
  }

  startAgent(request: AgentRequest): Observable<AgentRun> {
    return this.http.post<AgentRun>('/api/agent/runs', request);
  }

  getJira(): Observable<JiraHealth> {
    return this.http.get<JiraHealth>('/api/jira');
  }

  refreshJira(): Observable<JiraHealth> {
    return this.http.post<JiraHealth>('/api/jira/refresh', null);
  }

  finishAgent(id: string): Observable<AgentRun> {
    return this.http.post<AgentRun>(`/api/agent/runs/${encodeURIComponent(id)}/finish`, null);
  }

  agentLauncher(): Observable<AgentLauncher> {
    return this.http.get<AgentLauncher>('/api/agent/launcher');
  }

  branchPlace(name: string): Observable<{ place: BranchPlace }> {
    return this.http.get<{ place: BranchPlace }>('/api/agent/branch', { params: { name } });
  }

  openFile(file: NoteFile): Observable<void> {
    return this.http.post<void>('/api/open-file', file);
  }

  missingFiles(): Observable<{ missing: string[]; openable: boolean }> {
    return this.http.get<{ missing: string[]; openable: boolean }>('/api/note-files/missing');
  }

  removeLink(id: string, url: string): Observable<void> {
    return this.http.delete<void>(`${directionUrl(id)}/links`, { params: { url } });
  }

  addTodo(body: NewTodo): Observable<Todo> {
    return this.http.post<Todo>('/api/todos', body);
  }

  patchTodo(id: string, body: TodoPatch): Observable<Todo> {
    return this.http.patch<Todo>(todoUrl(id), body);
  }

  moveTodo(id: string, index: number): Observable<void> {
    return this.http.post<void>(`${todoUrl(id)}/move`, { index });
  }

  deleteTodo(id: string): Observable<void> {
    return this.http.delete<void>(todoUrl(id));
  }

  addQuickLink(body: NewQuickLink): Observable<QuickLinkGroup> {
    return this.http.post<QuickLinkGroup>('/api/link-groups', body);
  }

  undo(): Observable<HistoryAnswer> {
    return this.http.post<HistoryAnswer>('/api/undo', null);
  }

  redo(): Observable<HistoryAnswer> {
    return this.http.post<HistoryAnswer>('/api/redo', null);
  }

  setDailyText(body: DailyText): Observable<DailyDraft> {
    return this.http.put<DailyDraft>('/api/daily/text', body);
  }

  startSummary(): Observable<{ started: boolean }> {
    return this.http.post<{ started: boolean }>('/api/daily/summary', null);
  }

  removeSummaryItem(id: string): Observable<void> {
    return this.http.delete<void>(`/api/daily/items/${encodeURIComponent(id)}`);
  }

  setSummaryItemDirection(id: string, directionId: string | null): Observable<SummaryItem> {
    return this.http.patch<SummaryItem>(`/api/daily/items/${encodeURIComponent(id)}`, { directionId });
  }

  acceptCandidate(id: string): Observable<Todo> {
    return this.http.post<Todo>(`/api/daily/candidates/${encodeURIComponent(id)}/accept`, null);
  }

  dismissCandidate(id: string): Observable<void> {
    return this.http.delete<void>(`/api/daily/candidates/${encodeURIComponent(id)}`);
  }

  holdDaily(body: HeldDaily): Observable<Daily> {
    return this.http.post<Daily>('/api/daily/held', body);
  }

  removeQuickLink(groupId: string, url: string): Observable<void> {
    return this.http.delete<void>(`/api/link-groups/${encodeURIComponent(groupId)}/links`, { params: { url } });
  }
}

/** where a handed task opens and which agents can take it */
export interface AgentLauncher {
  terminal: Terminal;
  codeRoot: string;
  agents: Agent[];
  defaultAgent: Agent;
}
