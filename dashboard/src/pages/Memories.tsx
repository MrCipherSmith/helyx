import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { useReactTable, getCoreRowModel, flexRender, createColumnHelper, type ExpandedState, getExpandedRowModel } from '@tanstack/react-table'
import { api, type Memory } from '../api/client'
import { useI18n } from '../i18n'

function relativeTime(date: string): string {
  const diff = (Date.now() - new Date(date).getTime()) / 1000
  if (diff < 60) return `${Math.round(diff)}s ago`
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`
  return `${Math.round(diff / 86400)}d ago`
}

const TYPE_COLORS: Record<string, string> = {
  fact: 'bg-blue-900/50 text-blue-300',
  summary: 'bg-purple-900/50 text-purple-300',
  decision: 'bg-amber-900/50 text-amber-300',
  note: 'bg-gray-800 text-gray-400',
  project_context: 'bg-green-900/50 text-green-300',
}

export function MemoriesPage() {
  const queryClient = useQueryClient()
  const [type, setType] = useState<string | undefined>()
  const [search, setSearch] = useState('')
  const [activeTag, setActiveTag] = useState<string | undefined>()
  const [page, setPage] = useState(0)
  const [expanded, setExpanded] = useState<ExpandedState>({})
  const { t } = useI18n()

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['memories', { type, search, tag: activeTag, page }],
    queryFn: () => api.memories({ type, search: search || undefined, tag: activeTag, limit: 50, offset: page * 50 }),
    refetchInterval: 10_000,
  })

  const { data: tags } = useQuery({
    queryKey: ['memory-tags'],
    queryFn: () => api.memoryTags(),
    refetchInterval: 30_000,
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteMemory(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['memories'] }),
  })

  const deleteByTagMutation = useMutation({
    mutationFn: (tag: string) => api.deleteMemoriesByTag(tag),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['memories'] })
      queryClient.invalidateQueries({ queryKey: ['memory-tags'] })
      setActiveTag(undefined)
    },
  })

  const col = createColumnHelper<Memory>()
  const columns = [
    col.display({ id: 'expand', size: 30, cell: ({ row }) => <button onClick={row.getToggleExpandedHandler()} className="text-gray-500 hover:text-white">{row.getIsExpanded() ? '▼' : '▶'}</button> }),
    col.accessor('content', { header: t('memory.content'), cell: (info) => <span className="truncate block max-w-lg">{info.getValue().slice(0, 120)}{info.getValue().length > 120 ? '...' : ''}</span> }),
    col.accessor('type', { header: t('memory.type'), size: 80, cell: (info) => <span className={`text-xs px-2 py-0.5 rounded ${TYPE_COLORS[info.getValue()] ?? 'bg-gray-800 text-gray-400'}`}>{info.getValue()}</span> }),
    col.accessor('tags', { header: t('memory.tags'), size: 120, cell: (info) => { const tags = info.getValue(); return tags?.length ? <span className="text-gray-400 text-xs">{tags.join(', ')}</span> : <span className="text-gray-600">-</span> } }),
    col.accessor('project_path', { header: t('memory.project'), size: 100, cell: (info) => { const val = info.getValue(); return val ? <span className="text-gray-400">{val.split('/').pop()}</span> : <span className="text-gray-600">-</span> } }),
    col.accessor('created_at', { header: t('memory.created'), size: 130, cell: (info) => new Date(info.getValue()).toLocaleString() }),
    col.display({ id: 'actions', size: 60, cell: ({ row }) => <button onClick={() => { if (confirm(t('memory.deleteConfirm'))) deleteMutation.mutate(row.original.id) }} className="text-xs text-red-400 hover:text-red-300">{t('memory.deleteBtn')}</button> }),
  ]

  const table = useReactTable({
    data: data?.memories ?? [], columns, state: { expanded }, onExpandedChange: setExpanded,
    getCoreRowModel: getCoreRowModel(), getExpandedRowModel: getExpandedRowModel(), getRowCanExpand: () => true,
  })

  const totalPages = data ? Math.ceil(data.total / 50) : 0

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-white">{t('memory.title')}</h1>
          {data?.indexing && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-900/50 text-yellow-300 animate-pulse">
              Indexing...
            </span>
          )}
        </div>
        <button onClick={() => refetch()} className="text-sm text-gray-400 hover:text-white px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700">{t('common.refresh')}</button>
      </div>

      {/* L1: Hot Context */}
      {data?.hotContext && data.hotContext.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Hot Context</h2>
          <div className="grid gap-2">
            {data.hotContext.map((m) => (
              <div key={m.id} className="flex items-start gap-3 bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 hover:border-gray-600">
                <span className={`shrink-0 text-xs px-1.5 py-0.5 rounded ${TYPE_COLORS[m.type] ?? 'bg-gray-800 text-gray-400'}`}>{m.type}</span>
                <span className="text-sm text-gray-200 truncate flex-1">{m.content.slice(0, 150)}{m.content.length > 150 ? '...' : ''}</span>
                <span className="shrink-0 text-xs text-gray-600">{relativeTime(m.created_at)}</span>
                <button onClick={() => { if (confirm(t('memory.deleteConfirm'))) deleteMutation.mutate(m.id) }} className="shrink-0 text-xs text-red-500 hover:text-red-400">{t('memory.deleteBtn')}</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* L2: Tag Cloud */}
      {tags && tags.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Tags</h2>
            {activeTag && (
              <button onClick={() => setActiveTag(undefined)} className="text-xs text-gray-500 hover:text-gray-300">Clear filter</button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {tags.map(({ tag, count }) => (
              <div key={tag} className="flex items-center gap-1 group">
                <button
                  onClick={() => { setActiveTag(activeTag === tag ? undefined : tag); setPage(0) }}
                  className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                    activeTag === tag
                      ? 'bg-blue-700 border-blue-500 text-white'
                      : 'bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-500'
                  }`}
                >
                  {tag} <span className="opacity-60">{count}</span>
                </button>
                <button
                  onClick={() => { if (confirm(`Delete all memories tagged "${tag}"?`)) deleteByTagMutation.mutate(tag) }}
                  className="text-gray-700 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity text-xs"
                  title={`Delete all with tag "${tag}"`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <select value={type ?? ''} onChange={(e) => { setType(e.target.value || undefined); setPage(0) }} className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-300">
          <option value="">{t('memory.allTypes')}</option>
          <option value="fact">fact</option>
          <option value="summary">summary</option>
          <option value="decision">decision</option>
          <option value="note">note</option>
          <option value="project_context">project_context</option>
        </select>
        <input type="text" placeholder={t('memory.search')} value={search} onChange={(e) => { setSearch(e.target.value); setPage(0) }} className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-300 w-64" />
        {activeTag && (
          <span className="flex items-center gap-1 text-sm text-blue-300 bg-blue-900/30 border border-blue-800 rounded px-3 py-1.5">
            #{activeTag}
            <button onClick={() => setActiveTag(undefined)} className="text-blue-400 hover:text-white ml-1">×</button>
          </span>
        )}
      </div>

      {isLoading && <div className="text-gray-400">{t('common.loading')}</div>}
      {error && <div className="text-red-400">{t('common.error')}: {(error as Error).message}</div>}

      {/* Main table */}
      {data && (
        <>
          <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>{table.getHeaderGroups().map((hg) => (
                <tr key={hg.id} className="bg-gray-800/50">
                  {hg.headers.map((h) => <th key={h.id} className="text-left px-4 py-2 font-medium text-gray-400">{flexRender(h.column.columnDef.header, h.getContext())}</th>)}
                </tr>
              ))}</thead>
              <tbody className="divide-y divide-gray-800">
                {table.getRowModel().rows.map((row) => (
                  <>
                    <tr key={row.id} className="hover:bg-gray-800/30">
                      {row.getVisibleCells().map((cell) => <td key={cell.id} className="px-4 py-2">{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}
                    </tr>
                    {row.getIsExpanded() && (
                      <tr key={`${row.id}-exp`}>
                        <td colSpan={columns.length} className="px-4 py-3 bg-gray-800/50">
                          <pre className="text-sm text-gray-300 whitespace-pre-wrap break-words">{row.original.content}</pre>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
                {data.memories.length === 0 && <tr><td colSpan={columns.length} className="px-4 py-6 text-center text-gray-500">{t('memory.noMemories')}</td></tr>}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">{page * 50 + 1}-{Math.min((page + 1) * 50, data.total)} {t('logs.of')} {data.total}</span>
              <div className="flex gap-2">
                <button disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="text-sm px-3 py-1 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-40">{t('common.previous')}</button>
                <button disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)} className="text-sm px-3 py-1 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-40">{t('common.next')}</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
