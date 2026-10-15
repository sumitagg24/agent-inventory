import { useState, useEffect } from 'react';
import './App.css';

// Utility functions
const getKindIcon = (kind: string) => kind === 'mcp' ? '🔧' : '📝';
const getScopeBadge = (scope: string) => scope === 'user' ? '👤 User' : '📁 Project';

// Types
interface Item {
  id: string;
  kind: 'mcp' | 'skill';
  name: string;
  agent: string;
  scope: 'user' | 'project';
  config_path: string;
  launch_command?: string;
  description?: string;
  last_seen: string;
  tools?: Tool[];
}

interface Tool {
  id: string;
  item_id: string;
  tool_name: string;
  tool_description?: string;
  input_schema_json?: string;
  item_name?: string;
  agent?: string;
  kind?: string;
}

interface Stats {
  totalItems: number;
  totalTools: number;
  itemsWithTools: number;
  byKind: { kind: string; count: number }[];
  byAgent: { agent: string; count: number }[];
  byScope: { scope: string; count: number }[];
}

interface DoctorIssue {
  item: string;
  agent: string;
  scope: string;
  type: string;
  message: string;
  severity: 'error' | 'warning';
}

interface DoctorResult {
  healthy: boolean;
  issues: DoctorIssue[];
  summary: { total: number; errors: number; warnings: number };
}

function App() {
  const [view, setView] = useState<'dashboard' | 'items' | 'tools' | 'doctor' | 'item-detail'>('dashboard');
  const [items, setItems] = useState<Item[]>([]);
  const [filteredItems, setFilteredItems] = useState<Item[]>([]);
  const [tools, setTools] = useState<Tool[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [doctorResult, setDoctorResult] = useState<DoctorResult | null>(null);
  const [selectedItem, setSelectedItem] = useState<Item | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | 'mcp' | 'skill'>('all');
  const [agentFilter, setAgentFilter] = useState<string>('all');
  const [loading, setLoading] = useState(false);
  const [agents, setAgents] = useState<string[]>([]);

  useEffect(() => {
    fetchStats();
    fetchItems();
    fetchTools();
    fetchAgents();
  }, []);

  const fetchStats = async () => {
    try {
      const res = await fetch('/api/stats');
      const data = await res.json();
      setStats(data);
    } catch (err) {
      console.error('Failed to fetch stats:', err);
    }
  };

  const fetchItems = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (kindFilter !== 'all') params.set('kind', kindFilter);
      if (agentFilter !== 'all') params.set('agent', agentFilter);
      const res = await fetch(`/api/items?${params}`);
      const data = await res.json();
      setItems(data);
      setFilteredItems(data);
    } catch (err) {
      console.error('Failed to fetch items:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchTools = async () => {
    try {
      const res = await fetch('/api/tools');
      const data = await res.json();
      setTools(data);
    } catch (err) {
      console.error('Failed to fetch tools:', err);
    }
  };

  const fetchAgents = async () => {
    try {
      const res = await fetch('/api/items');
      const data = await res.json() as Item[];
      const agentList = [...new Set(data.map((i: Item) => i.agent))].sort();
      setAgents(agentList);
    } catch (err) {
      console.error('Failed to fetch agents:', err);
    }
  };

  const handleSearch = (term: string) => {
    setSearchTerm(term);
    let filtered = items;
    if (term) {
      const lower = term.toLowerCase();
      filtered = items.filter(item =>
        item.name.toLowerCase().includes(lower) ||
        item.description?.toLowerCase().includes(lower) ||
        item.agent.toLowerCase().includes(lower)
      );
    }
    setFilteredItems(filtered);
  };

  const handleKindFilter = (kind: 'all' | 'mcp' | 'skill') => {
    setKindFilter(kind);
    const params = new URLSearchParams();
    if (kind !== 'all') params.set('kind', kind);
    if (agentFilter !== 'all') params.set('agent', agentFilter);
    fetch(`/api/items?${params}`).then(r => r.json()).then(setFilteredItems);
  };

  const handleAgentFilter = (agent: string) => {
    setAgentFilter(agent);
    const params = new URLSearchParams();
    if (kindFilter !== 'all') params.set('kind', kindFilter);
    if (agent !== 'all') params.set('agent', agent);
    fetch(`/api/items?${params}`).then(r => r.json()).then(setFilteredItems);
  };

  const openItemDetail = async (item: Item) => {
    try {
      const res = await fetch(`/api/items/${item.id}`);
      const data = await res.json();
      setSelectedItem(data);
      setView('item-detail');
    } catch (err) {
      console.error('Failed to fetch item detail:', err);
    }
  };

  const runDoctor = async () => {
    try {
      const res = await fetch('/api/doctor');
      const data = await res.json();
      setDoctorResult(data);
      setView('doctor');
    } catch (err) {
      console.error('Failed to run doctor:', err);
    }
  };

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <h1>🔍 Agent Inventory</h1>
          <span className="subtitle">MCP Servers & Skills Dashboard</span>
        </div>
        <nav className="nav">
          <button className={view === 'dashboard' ? 'active' : ''} onClick={() => setView('dashboard')}>Dashboard</button>
          <button className={view === 'items' ? 'active' : ''} onClick={() => { setView('items'); fetchItems(); }}>All Items</button>
          <button className={view === 'tools' ? 'active' : ''} onClick={() => setView('tools')}>Tools</button>
          <button className={view === 'doctor' ? 'active' : ''} onClick={runDoctor}>Doctor</button>
        </nav>
      </header>

      <main className="main">
        {view === 'dashboard' && (
          <DashboardView stats={stats} items={items} onRunDoctor={runDoctor} />
        )}

        {view === 'items' && (
          <ItemsView
            items={filteredItems}
            searchTerm={searchTerm}
            onSearch={handleSearch}
            kindFilter={kindFilter}
            onKindFilter={handleKindFilter}
            agentFilter={agentFilter}
            onAgentFilter={handleAgentFilter}
            agents={agents}
            onItemClick={openItemDetail}
            loading={loading}
          />
        )}

        {view === 'tools' && (
          <ToolsView tools={tools} />
        )}

        {view === 'doctor' && (
          <DoctorView result={doctorResult} onRun={runDoctor} />
        )}

        {view === 'item-detail' && selectedItem && (
          <ItemDetailView item={selectedItem} onClose={() => setView('items')} />
        )}
      </main>
    </div>
  );
}

function DashboardView({ stats, items, onRunDoctor }: { stats: Stats | null; items: Item[]; onRunDoctor: () => void }) {
  if (!stats) return <div className="loading">Loading...</div>;

  return (
    <div className="dashboard">
      <div className="stats-grid">
        <StatCard title="Total Items" value={stats.totalItems} icon="📦" />
        <StatCard title="Total Tools" value={stats.totalTools} icon="🔧" />
        <StatCard title="Items with Tools" value={stats.itemsWithTools} icon="✅" />
        <StatCard title="Agents" value={stats.byAgent.length} icon="🤖" />
      </div>

      <div className="charts-grid">
        <div className="chart-card">
          <h3>By Kind</h3>
          <ul className="stat-list">
            {stats.byKind.map(k => (
              <li key={k.kind}><span className="kind-badge">{k.kind}</span> {k.count}</li>
            ))}
          </ul>
        </div>

        <div className="chart-card">
          <h3>By Agent</h3>
          <ul className="stat-list">
            {stats.byAgent.slice(0, 10).map(a => (
              <li key={a.agent}><span className="agent-badge">{a.agent}</span> {a.count}</li>
            ))}
          </ul>
        </div>

        <div className="chart-card">
          <h3>By Scope</h3>
          <ul className="stat-list">
            {stats.byScope.map(s => (
              <li key={s.scope}><span className="scope-badge">{s.scope}</span> {s.count}</li>
            ))}
          </ul>
        </div>

        <div className="chart-card">
          <h3>Quick Actions</h3>
          <div className="action-buttons">
            <button className="btn primary" onClick={onRunDoctor}>🏥 Run Health Check</button>
            <button className="btn secondary" onClick={() => window.open('/api/export?format=json', '_blank')}>📥 Export JSON</button>
          </div>
        </div>
      </div>

      <div className="recent-items">
        <h3>Recent Items</h3>
        <table className="items-table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Name</th>
              <th>Agent</th>
              <th>Scope</th>
              <th>Tools</th>
              <th>Last Seen</th>
            </tr>
          </thead>
          <tbody>
            {items.slice(0, 10).map(item => (
              <tr key={item.id}>
                <td><span className="kind-icon">{getKindIcon(item.kind)}</span></td>
                <td className="item-name">{item.name}</td>
                <td><span className="agent-badge">{item.agent}</span></td>
                <td><span className="scope-badge">{getScopeBadge(item.scope)}</span></td>
                <td>{item.tools?.length || 0}</td>
                <td>{new Date(item.last_seen).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({ title, value, icon }: { title: string; value: number; icon: string }) {
  return (
    <div className="stat-card">
      <div className="stat-icon">{icon}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-title">{title}</div>
    </div>
  );
}

function ItemsView({
  items,
  searchTerm,
  onSearch,
  kindFilter,
  onKindFilter,
  agentFilter,
  onAgentFilter,
  agents,
  onItemClick,
  loading,
}: {
  items: Item[];
  searchTerm: string;
  onSearch: (term: string) => void;
  kindFilter: 'all' | 'mcp' | 'skill';
  onKindFilter: (kind: 'all' | 'mcp' | 'skill') => void;
  agentFilter: string;
  onAgentFilter: (agent: string) => void;
  agents: string[];
  onItemClick: (item: Item) => void;
  loading: boolean;
}) {
  return (
    <div className="items-view">
      <div className="filters">
        <div className="search-box">
          <input
            type="text"
            placeholder="Search items..."
            value={searchTerm}
            onChange={(e) => onSearch(e.target.value)}
          />
        </div>
        <div className="filter-group">
          <select value={kindFilter} onChange={(e) => onKindFilter(e.target.value as 'all' | 'mcp' | 'skill')}>
            <option value="all">All Kinds</option>
            <option value="mcp">MCP Servers</option>
            <option value="skill">Skills</option>
          </select>
          <select value={agentFilter} onChange={(e) => onAgentFilter(e.target.value)}>
            <option value="all">All Agents</option>
            {agents.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
      </div>

      {loading ? (
        <div className="loading">Loading...</div>
      ) : (
        <table className="items-table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Name</th>
              <th>Description</th>
              <th>Agent</th>
              <th>Scope</th>
              <th>Launch Command</th>
              <th>Last Seen</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr><td colSpan={8} className="empty">No items found</td></tr>
            ) : (
              items.map(item => (
                <tr key={item.id} onClick={() => onItemClick(item)}>
                  <td><span className="kind-icon">{getKindIcon(item.kind)}</span></td>
                  <td className="item-name">{item.name}</td>
                  <td className="description">{item.description || '-'}</td>
                  <td><span className="agent-badge">{item.agent}</span></td>
                  <td><span className="scope-badge">{getScopeBadge(item.scope)}</span></td>
                  <td className="launch-command">{item.launch_command || '-'}</td>
                  <td>{new Date(item.last_seen).toLocaleDateString()}</td>
                  <td><button className="btn small" onClick={(e) => { e.stopPropagation(); onItemClick(item); }}>View</button></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}
      <div className="footer">
        Showing {items.length} items
      </div>
    </div>
  );
}

function ToolsView({ tools }: { tools: Tool[] }) {
  return (
    <div className="tools-view">
      <h2>All Tools ({tools.length})</h2>
      <table className="tools-table">
        <thead>
          <tr>
            <th>Tool Name</th>
            <th>Description</th>
            <th>Item</th>
            <th>Agent</th>
            <th>Kind</th>
          </tr>
        </thead>
        <tbody>
          {tools.map(tool => (
            <tr key={tool.id}>
              <td className="tool-name">{tool.tool_name}</td>
              <td>{tool.tool_description || '-'}</td>
              <td>{tool.item_name || '-'}</td>
              <td><span className="agent-badge">{tool.agent || '-'}</span></td>
              <td><span className="kind-badge">{tool.kind || '-'}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DoctorView({ result, onRun }: { result: DoctorResult | null; onRun: () => void }) {
  return (
    <div className="doctor-view">
      <div className="doctor-header">
        <h2>🏥 Health Check</h2>
        <button className="btn primary" onClick={onRun} disabled={result?.healthy === undefined}>
          {result?.healthy === undefined ? 'Running...' : 'Run Health Check'}
        </button>
      </div>

      {result && (
        <div className="doctor-result">
          <div className={`doctor-summary ${result.healthy ? 'healthy' : 'unhealthy'}`}>
            <h3>{result.healthy ? '✅ All Healthy' : '⚠️ Issues Found'}</h3>
            <div className="summary-stats">
              <span className="error">Errors: {result.summary.errors}</span>
              <span className="warning">Warnings: {result.summary.warnings}</span>
              <span>Total Items: {result.summary.total}</span>
            </div>
          </div>

          {result.issues.length > 0 && (
            <div className="issues-list">
              <h4>Issues</h4>
              {result.issues.map((issue, idx) => (
                <div key={idx} className={`issue ${issue.severity}`}>
                  <div className="issue-header">
                    <span className={`severity ${issue.severity}`}>
                      {issue.severity === 'error' ? '❌' : '⚠️'}
                    </span>
                    <span className="issue-item">{issue.item}</span>
                    <span className="issue-agent">{issue.agent} ({issue.scope})</span>
                    <span className="issue-type">{issue.type}</span>
                  </div>
                  <div className="issue-message">{issue.message}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ItemDetailView({ item, onClose }: { item: Item; onClose: () => void }) {
  return (
    <div className="item-detail">
      <div className="detail-header">
        <h2>{getKindIcon(item.kind)} {item.name}</h2>
        <button className="btn secondary" onClick={onClose}>← Back</button>
      </div>

      <div className="detail-grid">
        <div className="detail-section">
          <h3>Basic Info</h3>
          <dl>
            <dt>Kind</dt><dd><span className="kind-badge">{item.kind}</span></dd>
            <dt>Agent</dt><dd><span className="agent-badge">{item.agent}</span></dd>
            <dt>Scope</dt><dd><span className="scope-badge">{getScopeBadge(item.scope)}</span></dd>
            <dt>Config Path</dt><dd className="config-path">{item.config_path}</dd>
            {item.launch_command && (
              <>
                <dt>Launch Command</dt><dd className="launch-command">{item.launch_command}</dd>
              </>
            )}
            <dt>Last Seen</dt><dd>{new Date(item.last_seen).toLocaleString()}</dd>
          </dl>
        </div>

        {item.description && (
          <div className="detail-section">
            <h3>Description</h3>
            <p>{item.description}</p>
          </div>
        )}

        {item.tools && item.tools.length > 0 && (
          <div className="detail-section">
            <h3>Tools ({item.tools.length})</h3>
            <table className="tools-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Description</th>
                  <th>Input Schema</th>
                </tr>
              </thead>
              <tbody>
                {item.tools.map(tool => (
                  <tr key={tool.id}>
                    <td className="tool-name">{tool.tool_name}</td>
                    <td>{tool.tool_description || '-'}</td>
                    <td>
                      {tool.input_schema_json ? (
                        <pre className="schema">{JSON.stringify(JSON.parse(tool.input_schema_json), null, 2)}</pre>
                      ) : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;