import { useState, useRef, useEffect } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  CheckSquare,
  Calendar,
  Gamepad2,
  Smartphone,
  User,
  LayoutGrid,
  KeyRound,
  Globe,
  Key,
  Zap,
  MessageCircle,
  MessageSquare,
  RefreshCcw,
  MoreHorizontal,
  Languages,
  PanelLeftClose,
  PanelLeftOpen,
  Users,
  Settings,
  LogOut,
  Menu,
  BotMessageSquare,
  Music2,
  UsersRound,
  Clapperboard,
  GitBranch,
  Newspaper,
  Sun,
  Moon,
  UserRoundCog,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/AuthContext'
import { useTheme } from '@/components/theme-provider'
import ScrollRestoration from '@/components/ScrollRestoration'

const SCROLL_CONTAINER_ID = 'app-scroll-container'

function SidebarSection({
  label,
  collapsed,
  children,
}: {
  label: string
  collapsed: boolean
  children: React.ReactNode
}) {
  if (collapsed) return <div className="mt-4">{children}</div>
  return (
    <div className="mt-4">
      <p className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
        {label}
      </p>
      {children}
    </div>
  )
}

function SidebarLink({
  to,
  label,
  Icon,
  external,
  collapsed,
  onClick,
}: {
  to: string
  label: string
  Icon: React.ElementType
  external?: boolean
  collapsed?: boolean
  onClick?: () => void
}) {
  if (external) {
    return (
      <a
        href={to}
        target="_blank"
        rel="noopener noreferrer"
        title={collapsed ? label : undefined}
        onClick={onClick}
        className={cn(
          'flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
          collapsed && 'justify-center px-0',
        )}
      >
        <Icon className="size-4 shrink-0" />
        {!collapsed && label}
      </a>
    )
  }
  return (
    <NavLink
      to={to}
      title={collapsed ? label : undefined}
      onClick={onClick}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors',
          collapsed && 'justify-center px-0',
          isActive
            ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
            : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        )
      }
    >
      <Icon className="size-4 shrink-0" />
      {!collapsed && label}
    </NavLink>
  )
}

export default function AppLayout() {
  const { t, i18n } = useTranslation()
  const location = useLocation()
  const navigate = useNavigate()
  const { user, logout } = useAuth()
  const { theme, setTheme } = useTheme()
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)

  // Close user menu on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // Close mobile sidebar on navigation
  useEffect(() => {
    setMobileOpen(false)
  }, [location.pathname])

  const displayName = (() => {
    if (!user) return ''
    if (user.display_name) return user.display_name
    const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ')
    return fullName || user.username
  })()
  const initials = displayName
    ? displayName.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()
    : '?'

  const segments = location.pathname.split('/').filter(Boolean)
  const pageTitleKeys: Record<string, string> = {
    tasks: 'titles.tasks',
    schedules: 'titles.schedules',
    devices: 'titles.devices',
    'agent-groups': 'titles.agentGroups',
    'agent-group-chat': 'titles.agentGroupChat',
    content: 'titles.content',
    characters: 'titles.characters',
    credentials: 'titles.credentials',
    apps: 'titles.apps',
    profiles: 'titles.profiles',
    playground: 'titles.playground',
    proxies: 'titles.proxies',
    teams: 'titles.teams',
    profile: 'titles.profileSettings',
    'api-keys': 'titles.apiKeys',
    webhooks: 'titles.webhooks',
    tiktok: 'titles.tiktok',
    facebook: 'titles.facebook',
    workflow: 'titles.workflow',
  }
  const pageTitleKey =
    segments[0] === 'content' && segments[1] === 'video-samples'
      ? 'titles.contentSamples'
      : pageTitleKeys[segments[0]] ?? 'titles.dashboard'
  const pageTitle = t(pageTitleKey)

  function toggleLanguage() {
    i18n.changeLanguage(i18n.language === 'vi' ? 'en' : 'vi')
  }

  function toggleTheme() {
    setTheme(theme === 'dark' ? 'light' : 'dark')
  }

  const isDark = theme === 'dark'

  // Collapse state is only for desktop; on mobile sidebar is always full-width
  const sidebarCollapsed = collapsed

  return (
    <div className="flex h-screen overflow-hidden">
      <ScrollRestoration containerId={SCROLL_CONTAINER_ID} />
      {/* ── Mobile backdrop ── */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* ── Sidebar ── */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-all duration-200',
          'lg:relative lg:z-auto lg:translate-x-0',
          // Mobile: slide in/out
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
          // Desktop: width based on collapsed state
          sidebarCollapsed ? 'w-14' : 'w-64',
        )}
      >
        {/* Logo + collapse toggle */}
        <div
          className={cn(
            'flex items-center border-b border-sidebar-border px-4 py-4',
            sidebarCollapsed ? 'justify-center px-2' : 'gap-2',
          )}
        >
          {!sidebarCollapsed && (
            <>
              <span className="flex size-7 items-center justify-center rounded-md bg-foreground text-background text-sm font-bold">
                P
              </span>
              <span className="flex-1 text-base font-semibold tracking-tight text-sidebar-foreground">
                PhoneAgent
              </span>
            </>
          )}
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="hidden lg:flex items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            title={sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          >
            {sidebarCollapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          </button>
          {/* Mobile close button */}
          <button
            onClick={() => setMobileOpen(false)}
            className="flex lg:hidden items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <PanelLeftClose className="size-4" />
          </button>
        </div>

        {/* Nav */}
        <nav className={cn('flex-1 overflow-y-auto py-3', sidebarCollapsed ? 'px-1' : 'px-2')}>
          {/* Primary */}
          <SidebarLink to="/playground" label={t('nav.playground')} Icon={Gamepad2} collapsed={sidebarCollapsed} onClick={() => setMobileOpen(false)} />
          <SidebarLink to="/tasks" label={t('nav.tasks')} Icon={CheckSquare} collapsed={sidebarCollapsed} onClick={() => setMobileOpen(false)} />
          <SidebarLink to="/devices" label={t('nav.devices')} Icon={Smartphone} collapsed={sidebarCollapsed} onClick={() => setMobileOpen(false)} />
          <SidebarLink to="/agent-groups" label={t('nav.agentGroups')} Icon={BotMessageSquare} collapsed={sidebarCollapsed} onClick={() => setMobileOpen(false)} />
          <SidebarLink to="/agent-group-chat" label={t('nav.agentGroupChat')} Icon={MessageSquare} collapsed={sidebarCollapsed} onClick={() => setMobileOpen(false)} />
          <SidebarLink to="/content" label={t('nav.content')} Icon={Clapperboard} collapsed={sidebarCollapsed} onClick={() => setMobileOpen(false)} />
          <SidebarLink to="/characters" label={t('nav.characters')} Icon={UserRoundCog} collapsed={sidebarCollapsed} onClick={() => setMobileOpen(false)} />

          {/* Configuration */}
          <SidebarSection label={t('nav.configuration')} collapsed={sidebarCollapsed}>
            <SidebarLink to="/profiles" label={t('nav.profiles')} Icon={User} collapsed={sidebarCollapsed} onClick={() => setMobileOpen(false)} />
            <SidebarLink to="/apps" label={t('nav.apps')} Icon={LayoutGrid} collapsed={sidebarCollapsed} onClick={() => setMobileOpen(false)} />
            <SidebarLink to="/credentials" label={t('nav.credentials')} Icon={KeyRound} collapsed={sidebarCollapsed} onClick={() => setMobileOpen(false)} />
            <SidebarLink to="/proxies" label={t('nav.proxies')} Icon={Globe} collapsed={sidebarCollapsed} onClick={() => setMobileOpen(false)} />
          </SidebarSection>

          {/* Team */}
          <SidebarSection label={t('nav.team')} collapsed={sidebarCollapsed}>
            <SidebarLink to="/teams" label={t('nav.teams')} Icon={Users} collapsed={sidebarCollapsed} onClick={() => setMobileOpen(false)} />
          </SidebarSection>

          {/* Platform */}
          <SidebarSection label={t('nav.platform')} collapsed={sidebarCollapsed}>
            <SidebarLink to="/api-keys" label={t('nav.apiKeys')} Icon={Key} collapsed={sidebarCollapsed} onClick={() => setMobileOpen(false)} />
            <SidebarLink to="/webhooks" label={t('nav.webhooks')} Icon={Zap} collapsed={sidebarCollapsed} onClick={() => setMobileOpen(false)} />
            <SidebarLink to="/tiktok" label={t('nav.tiktok')} Icon={Music2} collapsed={sidebarCollapsed} onClick={() => setMobileOpen(false)} />
            <SidebarLink to="/tiktok-inbox" label={t('nav.tiktokInbox')} Icon={MessageCircle} collapsed={sidebarCollapsed} onClick={() => setMobileOpen(false)} />
            <SidebarLink to="/facebook" label={t('nav.facebook')} Icon={UsersRound} collapsed={sidebarCollapsed} onClick={() => setMobileOpen(false)} />
            <SidebarLink to="/websites" label={t('nav.websites')} Icon={Newspaper} collapsed={sidebarCollapsed} onClick={() => setMobileOpen(false)} />
          </SidebarSection>

          {/* Schedules */}
          <SidebarSection label={t('nav.automation')} collapsed={sidebarCollapsed}>
            <SidebarLink to="/schedules" label={t('nav.schedules')} Icon={Calendar} collapsed={sidebarCollapsed} onClick={() => setMobileOpen(false)} />
            <SidebarLink to="/workflow" label={t('nav.workflow')} Icon={GitBranch} collapsed={sidebarCollapsed} onClick={() => setMobileOpen(false)} />
          </SidebarSection>

        </nav>

        {/* User profile */}
        <div ref={userMenuRef} className="relative border-t border-sidebar-border px-3 py-3">
          <button
            onClick={() => setUserMenuOpen((v) => !v)}
            className={cn(
              'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-sidebar-accent',
              sidebarCollapsed && 'justify-center px-0',
            )}
            title={sidebarCollapsed ? displayName : undefined}
          >
            <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
              {initials}
            </div>
            {!sidebarCollapsed && (
              <>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-sidebar-foreground">{displayName}</p>
                  <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
                </div>
                <MoreHorizontal className="size-4 shrink-0 text-muted-foreground" />
              </>
            )}
          </button>

          {userMenuOpen && (
            <div className={cn(
              'absolute bottom-full mb-1 rounded-xl border border-border bg-popover shadow-lg z-50',
              sidebarCollapsed ? 'left-0 w-44' : 'left-2 right-2',
            )}>
              <div className="p-1">
                <button
                  onClick={() => { setUserMenuOpen(false); navigate('/profile') }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-muted"
                >
                  <Settings className="size-4" />
                  {t('auth.profileSettings')}
                </button>
                <button
                  onClick={() => { setUserMenuOpen(false); navigate('/teams') }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-muted"
                >
                  <Users className="size-4" />
                  {t('teams.title')}
                </button>
                <hr className="my-1 border-border" />
                <button
                  onClick={() => { logout(); navigate('/login') }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-destructive hover:bg-muted"
                >
                  <LogOut className="size-4" />
                  {t('auth.logout')}
                </button>
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* ── Right panel ── */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top header */}
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-background px-4">
          <div className="flex items-center gap-3">
            {/* Mobile hamburger */}
            <button
              onClick={() => setMobileOpen(true)}
              className="flex items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted lg:hidden"
              aria-label="Open menu"
            >
              <Menu className="size-5" />
            </button>
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <CheckSquare className="size-4 text-muted-foreground" />
              <span>{pageTitle}</span>
            </div>
            <div className="flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              <RefreshCcw className="size-3" />
              <span>0</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleTheme}
              className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              title={t('theme.toggle')}
            >
              {isDark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
              <span className="hidden sm:inline">{isDark ? t('theme.light') : t('theme.dark')}</span>
            </button>
            <button
              onClick={toggleLanguage}
              className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              title={t('language.label')}
            >
              <Languages className="size-3.5" />
              <span className="hidden sm:inline">{i18n.language === 'vi' ? t('language.en') : t('language.vi')}</span>
            </button>
            <a
              href="#"
              className="hidden sm:flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              <MessageCircle className="size-3.5" />
              {t('nav.support')}
            </a>
            <a
              href="#"
              className="hidden sm:flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              <MessageSquare className="size-3.5" />
              {t('nav.feedback')}
            </a>
          </div>
        </header>

        {/* Page content */}
        <main id={SCROLL_CONTAINER_ID} className="flex-1 overflow-auto bg-background p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
