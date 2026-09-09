import './Card.css'

/**
 * Card genérico do Design System.
 *
 * <Card
 *   icon={Globe}
 *   iconColor="#2563eb"
 *   iconBg="#eff4ff"
 *   title="meusite.com"
 *   subtitle="Ativo desde 12 mar 2025"
 *   badge={{ label: 'Online', tone: 'success' }}
 *   footer={<button className="btn btn-secondary btn-sm">Gerenciar</button>}
 * />
 */
function Card({ icon: Icon, iconColor, iconBg, title, subtitle, badge, footer, children }) {
  return (
    <div className="ds-card">
      <div className="ds-card-top">
        {Icon && (
          <span className="ds-card-icon" style={{ background: iconBg, color: iconColor }}>
            <Icon size={20} strokeWidth={2} />
          </span>
        )}

        {badge && (
          <span className={`ds-badge ds-badge-${badge.tone || 'default'}`}>
            {badge.label}
          </span>
        )}
      </div>

      {title && <h3 className="ds-card-title">{title}</h3>}
      {subtitle && <p className="ds-card-subtitle">{subtitle}</p>}

      {children && <div className="ds-card-body">{children}</div>}
      {footer && <div className="ds-card-footer">{footer}</div>}
    </div>
  )
}

export default Card
