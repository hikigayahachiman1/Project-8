export default function ToolTabs({ tabs, activeTab, onTabChange }) {
  return (
    <nav className="tool-tabs" aria-label="Menu fitur Parser QRIS">
      {tabs.map(tab => (
        <button
          className={`tool-tab${activeTab === tab.key ? ' active' : ''}`}
          key={tab.key}
          type="button"
          onClick={() => onTabChange(tab.key)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
