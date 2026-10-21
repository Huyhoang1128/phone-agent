import { useEffect, useState } from "react"
import { keepPreviousData, useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { useTranslation } from "react-i18next"
import {
  Plus,
  Trash2,
  Play,
  Square,
  Search,
  Columns2,
  RefreshCw,
  ChevronDown,
  ChevronsLeft,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  ArrowUpDown,
  Loader2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { TaskStatusBadge } from "@/components/StatusBadge"
import { tasksApi } from "@/lib/api"
import type { PaginatedResponse, Task, TaskStatus } from "@/lib/types"
import { useToast } from "@/context/ToastContext"

type FilterTab = "all" | TaskStatus

const FILTER_TABS: { key: FilterTab; labelKey: string }[] = [
  { key: "all", labelKey: "taskList.allTasks" },
  { key: "running", labelKey: "taskList.running" },
  { key: "cancelled", labelKey: "taskList.cancelled" },
  { key: "failed", labelKey: "taskList.failed" },
  { key: "completed", labelKey: "taskList.completed" },
]

const ROWS_PER_PAGE_OPTIONS = [10, 25, 50, 100]
const DESCRIPTION_COLLAPSE_THRESHOLD = 120
const TASK_COLUMN_WIDTH = "28rem"

export default function TaskList() {
  const { t } = useTranslation()
  const { showToast } = useToast()
  const qc = useQueryClient()
  const [expandedTaskIds, setExpandedTaskIds] = useState<
    Record<number, boolean>
  >({})
  const [activeTab, setActiveTab] = useState<FilterTab>("all")
  const [search, setSearch] = useState("")
  const [rowsPerPage, setRowsPerPage] = useState(10)
  const [page, setPage] = useState(1)
  const [pendingRunId, setPendingRunId] = useState<number | null>(null)

  const searchTerm = search.trim() || undefined
  const statusFilter = activeTab === "all" ? undefined : activeTab

  const {
    data: paginatedTasks,
    isLoading,
    refetch,
  } = useQuery<PaginatedResponse<Task>>({
    queryKey: ["tasks", page, rowsPerPage, activeTab, searchTerm ?? ""],
    queryFn: () =>
      tasksApi.list({
        page,
        page_size: rowsPerPage,
        status: statusFilter,
        search: searchTerm,
        ordering: "-created_at",
      }),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  })

  useEffect(() => {
    if (paginatedTasks && page > Math.max(1, Math.ceil(paginatedTasks.count / rowsPerPage))) {
      setPage(Math.max(1, Math.ceil(paginatedTasks.count / rowsPerPage)))
    }
  }, [page, paginatedTasks, rowsPerPage])

  const tasks = paginatedTasks?.results ?? []

  const deleteMutation = useMutation({
    mutationFn: tasksApi.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  })

  const runMutation = useMutation({
    mutationFn: (id: number) => tasksApi.run(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks"] })
      setPendingRunId(null)
      showToast(t("taskList.taskStarted"), "success")
    },
    onError: () => {
      setPendingRunId(null)
      showToast(t("taskList.taskRunError"), "error")
    },
  })

  const stopMutation = useMutation({
    mutationFn: (id: number) => tasksApi.stop(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  })

  // Pagination
  const totalPages = Math.max(1, Math.ceil((paginatedTasks?.count ?? 0) / rowsPerPage))
  const safePage = Math.min(page, totalPages)
  const pageRows = tasks

  return (
    <div className="flex flex-col gap-3">
      {/* Live-Updates indicator */}
      <div className="flex justify-end">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {t("common.liveUpdates")}
          <span className="inline-block size-2 rounded-full bg-green-500" />
        </span>
      </div>

      {/* Filter tabs + search + controls */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Tabs */}
        <div className="flex items-center rounded-lg border border-border bg-background p-0.5">
          {FILTER_TABS.map(({ key, labelKey }) => (
            <button
              key={key}
              onClick={() => {
                setActiveTab(key)
                setPage(1)
              }}
              className={
                activeTab === key
                  ? "rounded-md bg-foreground px-3 py-1 text-xs font-semibold text-background"
                  : "rounded-md px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              }
            >
              {t(labelKey)}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative min-w-40 flex-1">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder={t("taskList.searchTask")}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
            className="h-8 w-full rounded-lg border border-border bg-background pr-3 pl-8 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
          />
        </div>

        {/* New Task */}
        <Button asChild size="sm">
          <Link to="/tasks/new">
            <Plus className="mr-1 size-4" />
            {t("taskList.newTask")}
          </Link>
        </Button>

        {/* Columns button */}
        <button className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted">
          <Columns2 className="size-3.5" />
          {t("taskList.columns")}
          <ChevronDown className="size-3" />
        </button>

        {/* Refresh button */}
        <button
          onClick={() => refetch()}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted"
          aria-label={t("common.refresh")}
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-border">
        {isLoading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            {t("common.loading")}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/50">
              <tr>
                <th
                  className="px-4 py-3 text-left text-xs font-medium text-muted-foreground"
                  style={{
                    width: TASK_COLUMN_WIDTH,
                    maxWidth: TASK_COLUMN_WIDTH,
                  }}
                >
                  {t("taskList.task")}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">
                  {t("taskList.status")}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">
                  {t("taskList.llmModel")}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">
                  {t("taskList.steps")}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">
                  {t("taskList.finished")}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">
                  <button className="flex items-center gap-1 transition-colors hover:text-foreground">
                    {t("taskList.created")}
                    <ArrowUpDown className="size-3" />
                  </button>
                </th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    {t("taskList.noTasks")}
                  </td>
                </tr>
              ) : (
                pageRows.map((task) => {
                  const isExpanded = Boolean(expandedTaskIds[task.id])
                  const descriptionClassName = isExpanded
                    ? "mt-0.5 break-words text-xs text-muted-foreground"
                    : "mt-0.5 break-words text-xs text-muted-foreground line-clamp-2"

                  return (
                    <tr
                      key={task.id}
                      className="border-t border-border hover:bg-muted/40"
                    >
                      <td
                        className="px-4 py-3 align-top"
                        style={{ maxWidth: TASK_COLUMN_WIDTH }}
                      >
                        <div>
                          <Link
                            to={`/tasks/${task.id}`}
                            className="block font-medium break-words hover:underline"
                          >
                            {task.name}
                          </Link>
                          {task.description && (
                            <>
                              <p className={descriptionClassName}>
                                {task.description}
                              </p>
                              {task.description.length >
                                DESCRIPTION_COLLAPSE_THRESHOLD && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setExpandedTaskIds((prev) => ({
                                      ...prev,
                                      [task.id]: !prev[task.id],
                                    }))
                                  }
                                  className="mt-1 text-xs font-medium text-primary hover:underline"
                                >
                                  {isExpanded
                                    ? t("taskList.showLess")
                                    : t("taskList.showMore")}
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <TaskStatusBadge status={task.status} />
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {task.llm_model ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {task.steps ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {task.finished_at
                          ? new Date(task.finished_at).toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' })
                          : "—"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {new Date(task.created_at).toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' })}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {task.status === "running" ? (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => stopMutation.mutate(task.id)}
                              disabled={stopMutation.isPending}
                              aria-label={t("taskList.stopTask")}
                            >
                              <Square className="size-4 text-destructive" />
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => {
                                setPendingRunId(task.id)
                                runMutation.mutate(task.id)
                              }}
                              disabled={pendingRunId === task.id}
                              aria-label={t("taskList.runTask")}
                            >
                              {pendingRunId === task.id ? (
                                <Loader2 className="size-4 animate-spin text-muted-foreground" />
                              ) : (
                                <Play className="size-4 text-green-600" />
                              )}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => deleteMutation.mutate(task.id)}
                            aria-label={t("taskList.deleteTask")}
                          >
                            <Trash2 className="size-4 text-destructive" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-end gap-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <span>{t("common.rowsPerPage")}</span>
          <div className="relative">
            <select
              value={rowsPerPage}
              onChange={(e) => {
                setRowsPerPage(Number(e.target.value))
                setPage(1)
              }}
              className="h-7 appearance-none rounded border border-border bg-background pr-6 pl-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
            >
              {ROWS_PER_PAGE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute top-1/2 right-1.5 size-3 -translate-y-1/2" />
          </div>
        </div>
        <span>
          {t("common.page")} {safePage} {t("common.of")} {totalPages}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            disabled={safePage === 1}
            onClick={() => setPage(1)}
            className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background transition-colors hover:bg-muted disabled:opacity-40"
          >
            <ChevronsLeft className="size-3.5" />
          </button>
          <button
            disabled={safePage === 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background transition-colors hover:bg-muted disabled:opacity-40"
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <button
            disabled={safePage >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background transition-colors hover:bg-muted disabled:opacity-40"
          >
            <ChevronRight className="size-3.5" />
          </button>
          <button
            disabled={safePage >= totalPages}
            onClick={() => setPage(totalPages)}
            className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background transition-colors hover:bg-muted disabled:opacity-40"
          >
            <ChevronsRight className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
