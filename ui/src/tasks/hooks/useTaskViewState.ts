import { useReducer, useEffect, useCallback, useRef } from 'react'
import type { TaskState, Priority } from '../model/taskModel'

export type ActiveView = 'board' | 'list' | 'graph' | 'archive'
export type ListSort = 'priority' | 'state' | 'title' | 'updated'
export type ListGroupBy = 'none' | 'state' | 'priority' | 'parent' | 'agent'
export type ListDensity = 'compact' | 'normal' | 'comfortable'

export type TaskFilters = {
  states: Set<TaskState>
  priorities: Set<Priority>
  agents: Set<string>
  tags: Set<string>
  parentId: string | null
}

export type TaskViewState = {
  activeView: ActiveView
  selectedTaskId: string | null
  detailPanelOpen: boolean
  filters: TaskFilters
  searchQuery: string
  listSort: ListSort
  listGroupBy: ListGroupBy
  listDensity: ListDensity
  listSelectedIds: Set<string>
  boardColumnCollapsed: Set<TaskState>
  graphCollapsedIds: Set<string>
}

const ALL_STATES = new Set<TaskState>(['ready', 'running', 'done', 'blocked', 'cancelled'])
const ALL_PRIORITIES = new Set<Priority>(['critical', 'high', 'normal', 'low'])

function defaultState(): TaskViewState {
  return {
    activeView: 'graph',
    selectedTaskId: null,
    detailPanelOpen: false,
    filters: {
      states: new Set(ALL_STATES),
      priorities: new Set(ALL_PRIORITIES),
      agents: new Set(),
      tags: new Set(),
      parentId: null,
    },
    searchQuery: '',
    listSort: 'priority',
    listGroupBy: 'state',
    listDensity: 'normal',
    listSelectedIds: new Set(),
    boardColumnCollapsed: new Set(),
    graphCollapsedIds: new Set(),
  }
}

// Serializable shape for localStorage
type PersistedState = {
  activeView: ActiveView
  listSort: ListSort
  listGroupBy: ListGroupBy
  listDensity: ListDensity
  filterStates: TaskState[]
  filterPriorities: Priority[]
  boardColumnCollapsed: TaskState[]
  graphCollapsedIds: string[]
}

function loadState(project: string): TaskViewState {
  const base = defaultState()
  try {
    const stored = localStorage.getItem(`workflow-tasks:${project}`)
    if (!stored) return base
    const p: Partial<PersistedState> = JSON.parse(stored)
    return {
      ...base,
      activeView: p.activeView ?? base.activeView,
      listSort: p.listSort ?? base.listSort,
      listGroupBy: p.listGroupBy ?? base.listGroupBy,
      listDensity: p.listDensity ?? base.listDensity,
      filters: {
        ...base.filters,
        states: p.filterStates ? new Set(p.filterStates) : base.filters.states,
        priorities: p.filterPriorities ? new Set(p.filterPriorities) : base.filters.priorities,
      },
      boardColumnCollapsed: p.boardColumnCollapsed ? new Set(p.boardColumnCollapsed) : base.boardColumnCollapsed,
      graphCollapsedIds: p.graphCollapsedIds ? new Set(p.graphCollapsedIds) : base.graphCollapsedIds,
    }
  } catch {
    return base
  }
}

function persistState(project: string, state: TaskViewState): void {
  const p: PersistedState = {
    activeView: state.activeView,
    listSort: state.listSort,
    listGroupBy: state.listGroupBy,
    listDensity: state.listDensity,
    filterStates: [...state.filters.states],
    filterPriorities: [...state.filters.priorities],
    boardColumnCollapsed: [...state.boardColumnCollapsed],
    graphCollapsedIds: [...state.graphCollapsedIds],
  }
  localStorage.setItem(`workflow-tasks:${project}`, JSON.stringify(p))
}

type Action =
  | { type: 'SET_VIEW'; view: ActiveView }
  | { type: 'SELECT_TASK'; id: string | null }
  | { type: 'TOGGLE_DETAIL_PANEL'; open?: boolean }
  | { type: 'TOGGLE_FILTER_STATE'; state: TaskState }
  | { type: 'TOGGLE_FILTER_PRIORITY'; priority: Priority }
  | { type: 'TOGGLE_FILTER_AGENT'; agent: string }
  | { type: 'TOGGLE_FILTER_TAG'; tag: string }
  | { type: 'SET_PARENT_FILTER'; parentId: string | null }
  | { type: 'SET_SEARCH'; query: string }
  | { type: 'SET_LIST_SORT'; sort: ListSort }
  | { type: 'SET_LIST_GROUP_BY'; groupBy: ListGroupBy }
  | { type: 'SET_LIST_DENSITY'; density: ListDensity }
  | { type: 'SET_LIST_SELECTED'; ids: Set<string> }
  | { type: 'TOGGLE_BOARD_COLUMN'; state: TaskState }
  | { type: 'TOGGLE_GRAPH_COLLAPSED'; id: string }
  | { type: 'SET_GRAPH_COLLAPSED'; ids: Set<string> }
  | { type: 'RESET_FILTERS' }
  | { type: 'LOAD_PROJECT'; project: string }

function toggleInSet<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

function reducer(state: TaskViewState, action: Action): TaskViewState {
  switch (action.type) {
    case 'SET_VIEW':
      return { ...state, activeView: action.view }
    case 'SELECT_TASK':
      return { ...state, selectedTaskId: action.id, detailPanelOpen: action.id !== null }
    case 'TOGGLE_DETAIL_PANEL':
      return { ...state, detailPanelOpen: action.open ?? !state.detailPanelOpen }
    case 'TOGGLE_FILTER_STATE':
      return { ...state, filters: { ...state.filters, states: toggleInSet(state.filters.states, action.state) } }
    case 'TOGGLE_FILTER_PRIORITY':
      return { ...state, filters: { ...state.filters, priorities: toggleInSet(state.filters.priorities, action.priority) } }
    case 'TOGGLE_FILTER_AGENT':
      return { ...state, filters: { ...state.filters, agents: toggleInSet(state.filters.agents, action.agent) } }
    case 'TOGGLE_FILTER_TAG':
      return { ...state, filters: { ...state.filters, tags: toggleInSet(state.filters.tags, action.tag) } }
    case 'SET_PARENT_FILTER':
      return { ...state, filters: { ...state.filters, parentId: action.parentId } }
    case 'SET_SEARCH':
      return { ...state, searchQuery: action.query }
    case 'SET_LIST_SORT':
      return { ...state, listSort: action.sort }
    case 'SET_LIST_GROUP_BY':
      return { ...state, listGroupBy: action.groupBy }
    case 'SET_LIST_DENSITY':
      return { ...state, listDensity: action.density }
    case 'SET_LIST_SELECTED':
      return { ...state, listSelectedIds: action.ids }
    case 'TOGGLE_BOARD_COLUMN':
      return { ...state, boardColumnCollapsed: toggleInSet(state.boardColumnCollapsed, action.state) }
    case 'TOGGLE_GRAPH_COLLAPSED':
      return { ...state, graphCollapsedIds: toggleInSet(state.graphCollapsedIds, action.id) }
    case 'SET_GRAPH_COLLAPSED':
      return { ...state, graphCollapsedIds: action.ids }
    case 'RESET_FILTERS':
      return { ...state, filters: defaultState().filters, searchQuery: '' }
    case 'LOAD_PROJECT':
      return loadState(action.project)
  }
}

export function useTaskViewState(projectName: string) {
  const [state, dispatch] = useReducer(reducer, projectName, loadState)
  const prevProjectRef = useRef(projectName)

  // Reset state when project changes
  useEffect(() => {
    if (prevProjectRef.current !== projectName) {
      prevProjectRef.current = projectName
      dispatch({ type: 'LOAD_PROJECT', project: projectName })
    }
  }, [projectName])

  // Persist on change
  useEffect(() => {
    persistState(projectName, state)
  }, [projectName, state])

  // Convenience dispatchers
  const setActiveView = useCallback((view: ActiveView) => dispatch({ type: 'SET_VIEW', view }), [])
  const setSelectedTask = useCallback((id: string | null) => dispatch({ type: 'SELECT_TASK', id }), [])
  const toggleDetailPanel = useCallback((open?: boolean) => dispatch({ type: 'TOGGLE_DETAIL_PANEL', open }), [])
  const toggleFilterState = useCallback((s: TaskState) => dispatch({ type: 'TOGGLE_FILTER_STATE', state: s }), [])
  const toggleFilterPriority = useCallback((p: Priority) => dispatch({ type: 'TOGGLE_FILTER_PRIORITY', priority: p }), [])
  const toggleFilterAgent = useCallback((a: string) => dispatch({ type: 'TOGGLE_FILTER_AGENT', agent: a }), [])
  const toggleFilterTag = useCallback((t: string) => dispatch({ type: 'TOGGLE_FILTER_TAG', tag: t }), [])
  const setParentFilter = useCallback((id: string | null) => dispatch({ type: 'SET_PARENT_FILTER', parentId: id }), [])
  const setSearchQuery = useCallback((q: string) => dispatch({ type: 'SET_SEARCH', query: q }), [])
  const setListSort = useCallback((s: ListSort) => dispatch({ type: 'SET_LIST_SORT', sort: s }), [])
  const setListGroupBy = useCallback((g: ListGroupBy) => dispatch({ type: 'SET_LIST_GROUP_BY', groupBy: g }), [])
  const setListDensity = useCallback((d: ListDensity) => dispatch({ type: 'SET_LIST_DENSITY', density: d }), [])
  const setListSelected = useCallback((ids: Set<string>) => dispatch({ type: 'SET_LIST_SELECTED', ids }), [])
  const toggleBoardColumn = useCallback((s: TaskState) => dispatch({ type: 'TOGGLE_BOARD_COLUMN', state: s }), [])
  const toggleGraphCollapsed = useCallback((id: string) => dispatch({ type: 'TOGGLE_GRAPH_COLLAPSED', id }), [])
  const setGraphCollapsed = useCallback((ids: Set<string>) => dispatch({ type: 'SET_GRAPH_COLLAPSED', ids }), [])
  const resetFilters = useCallback(() => dispatch({ type: 'RESET_FILTERS' }), [])

  return {
    state,
    dispatch,
    setActiveView,
    setSelectedTask,
    toggleDetailPanel,
    toggleFilterState,
    toggleFilterPriority,
    toggleFilterAgent,
    toggleFilterTag,
    setParentFilter,
    setSearchQuery,
    setListSort,
    setListGroupBy,
    setListDensity,
    setListSelected,
    toggleBoardColumn,
    toggleGraphCollapsed,
    setGraphCollapsed,
    resetFilters,
  }
}
