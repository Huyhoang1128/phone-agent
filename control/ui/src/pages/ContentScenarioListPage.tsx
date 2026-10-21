/**
 * Legacy route — redirect tới /content?tab=scenario.
 *
 * v3.2.1 ban đầu mở standalone list page riêng cho AI Scenario, nhưng user
 * yêu cầu merge UX vào ContentPage (tab thứ 5). Route `/content-scenarios/`
 * vẫn giữ để backward compat link nhưng auto-redirect.
 */
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

export default function ContentScenarioListPage() {
  const navigate = useNavigate()
  useEffect(() => {
    navigate('/content?tab=scenario', { replace: true })
  }, [navigate])
  return null
}
