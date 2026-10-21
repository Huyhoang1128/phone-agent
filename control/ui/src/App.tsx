import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider } from '@/context/AuthContext'
import { ToastProvider } from '@/context/ToastContext'
import PrivateRoute from '@/components/PrivateRoute'
import AppLayout from '@/components/AppLayout'
import LoginPage from '@/pages/LoginPage'
import RegisterPage from '@/pages/RegisterPage'
import TaskList from '@/pages/TaskList'
import TaskForm from '@/pages/TaskForm'
import TaskDetailPage from '@/pages/TaskDetailPage'
import ScheduleList from '@/pages/ScheduleList'
import ScheduleForm from '@/pages/ScheduleForm'
import ScheduleDetail from '@/pages/ScheduleDetail'
import DevicesPage from '@/pages/DevicesPage'
import DeviceDetailPage from '@/pages/DeviceDetailPage'
import CredentialsPage from '@/pages/CredentialsPage'
import AppsPage from '@/pages/AppsPage'
import ProfilesPage from '@/pages/ProfilesPage'
import PlaygroundPage from '@/pages/PlaygroundPage'
import TeamsPage from '@/pages/TeamsPage'
import TeamDetailPage from '@/pages/TeamDetailPage'
import ProfileSettingsPage from '@/pages/ProfileSettingsPage'
import ProxiesPage from '@/pages/ProxiesPage'
import AgentGroupsPage from '@/pages/AgentGroupsPage'
import AgentGroupChatPage from '@/pages/AgentGroupChatPage'
import ContentPage from '@/pages/ContentPage'
import VideoSamplePage from '@/pages/VideoSamplePage'
import ContentDetailPage from '@/pages/ContentDetailPage'
import ContentDraftPage from '@/pages/ContentDraftPage'
import ContentScenarioDraftPage from '@/pages/ContentScenarioDraftPage'
import ContentScenarioDetailPage from '@/pages/ContentScenarioDetailPage'
import ContentScenarioListPage from '@/pages/ContentScenarioListPage'
import ConvertScriptToVideoPage from '@/pages/ConvertScriptToVideoPage'
import CrawlSourceDetailPage from '@/pages/CrawlSourceDetailPage'
import CrawlSnapshotDetailPage from '@/pages/CrawlSnapshotDetailPage'
import ApiKeysPage from '@/pages/ApiKeysPage'
import ApiDocsPage from '@/pages/ApiDocsPage'
import WebhooksPage from '@/pages/WebhooksPage'
import TiktokPage from '@/pages/TiktokPage'
import TiktokVideoDetailPage from '@/pages/TiktokVideoDetailPage'
import TiktokInboxPage from '@/pages/TiktokInboxPage'
import FacebookPage from '@/pages/FacebookPage'
import FacebookPageDetailPage from '@/pages/FacebookPageDetailPage'
import FacebookGroupDetailPage from '@/pages/FacebookGroupDetailPage'
import FacebookProfileDetailPage from '@/pages/FacebookProfileDetailPage'
import FacebookScheduledCommentPage from '@/pages/FacebookScheduledCommentPage'
import FacebookPostDetailPage from '@/pages/FacebookPostDetailPage'
import WebsitesPage from '@/pages/WebsitesPage'
import WebsiteDetailPage from '@/pages/WebsiteDetailPage'
import WorkflowPage from '@/pages/WorkflowPage'
import WorkflowForm from '@/pages/WorkflowForm'
import WorkflowDetailPage from '@/pages/WorkflowDetailPage'
import CharactersPage from '@/pages/CharactersPage'
import QuickImagePage from '@/pages/QuickImagePage'

const queryClient = new QueryClient()

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>
        <BrowserRouter>
          <Routes>
            {/* Public routes */}
            <Route path="login" element={<LoginPage />} />
            <Route path="register" element={<RegisterPage />} />

            {/* Protected routes */}
            <Route element={<PrivateRoute />}>
              <Route element={<AppLayout />}>
                <Route index element={<Navigate to="/playground" replace />} />
                <Route path="playground" element={<PlaygroundPage />} />
                <Route path="tasks" element={<TaskList />} />
                <Route path="tasks/new" element={<TaskForm />} />
                <Route path="tasks/:id" element={<TaskDetailPage />} />
                <Route path="tasks/:id/edit" element={<TaskForm />} />
                <Route path="schedules" element={<ScheduleList />} />
                <Route path="schedules/new" element={<ScheduleForm />} />
                <Route path="schedules/:id" element={<ScheduleDetail />} />
                <Route path="devices" element={<DevicesPage />} />
                <Route path="devices/:id" element={<DeviceDetailPage />} />
                <Route path="credentials" element={<CredentialsPage />} />
                <Route path="apps" element={<AppsPage />} />
                <Route path="profiles" element={<ProfilesPage />} />
                <Route path="proxies" element={<ProxiesPage />} />
                <Route path="agent-groups" element={<AgentGroupsPage />} />
                <Route path="agent-group-chat" element={<AgentGroupChatPage />} />
                <Route path="content" element={<ContentPage />} />
                <Route path="characters" element={<CharactersPage />} />
                <Route path="characters/quick" element={<QuickImagePage />} />
                <Route path="content/video-samples" element={<VideoSamplePage />} />
                <Route path="content/draft" element={<ContentDraftPage />} />
                <Route path="content/:id" element={<ContentDetailPage />} />
                <Route path="content-scenarios" element={<ContentScenarioListPage />} />
                <Route path="content-scenarios/draft" element={<ContentScenarioDraftPage />} />
                <Route path="content-scenarios/:id" element={<ContentScenarioDetailPage />} />
                <Route path="content/:id/convert-to-video" element={<ConvertScriptToVideoPage />} />
                <Route path="content/crawl-sources/:id" element={<CrawlSourceDetailPage />} />
                <Route path="content/crawl-snapshots/:id" element={<CrawlSnapshotDetailPage />} />
                <Route path="teams" element={<TeamsPage />} />
                <Route path="teams/:id" element={<TeamDetailPage />} />
                <Route path="profile" element={<ProfileSettingsPage />} />
                <Route path="api-keys" element={<ApiKeysPage />} />
                <Route path="api-docs" element={<ApiDocsPage />} />
                <Route path="webhooks" element={<WebhooksPage />} />
                <Route path="tiktok" element={<TiktokPage />} />
                <Route path="tiktok/:id" element={<TiktokVideoDetailPage />} />
                <Route path="tiktok-inbox" element={<TiktokInboxPage />} />
                <Route path="facebook" element={<FacebookPage />} />
                <Route path="facebook/pages/:id" element={<FacebookPageDetailPage />} />
                <Route path="facebook/groups/:id" element={<FacebookGroupDetailPage />} />
                <Route path="facebook/profiles/:id" element={<FacebookProfileDetailPage />} />
                <Route path="facebook/scheduled-posts/:postId/comments" element={<FacebookScheduledCommentPage />} />
                <Route path="facebook/posts/:id" element={<FacebookPostDetailPage />} />
                <Route path="websites" element={<WebsitesPage />} />
                <Route path="websites/:id" element={<WebsiteDetailPage />} />
                <Route path="workflow" element={<WorkflowPage />} />
                <Route path="workflow/new" element={<WorkflowForm />} />
                <Route path="workflow/:id" element={<WorkflowDetailPage />} />
                <Route path="workflow/:id/edit" element={<WorkflowForm />} />
              </Route>
            </Route>
          </Routes>
        </BrowserRouter>
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  )
}

export default App
