"""
Standalone test script for TikTok tools.

Usage:
    # Test open_file_manager_at_video:
    python apps/tiktok/test_tools.py open_file_manager

    # Test share_video_file_to_tiktok (file manager must already be at DCIM/Camera):
    python apps/tiktok/test_tools.py share_video

    # Test complete_video_upload:
    python apps/tiktok/test_tools.py complete_upload

    # Test download_video_to_device:
    python apps/tiktok/test_tools.py download_video --url https://samplelib.com/mp4/sample-5s.mp4

    # Specify a device serial:
    python apps/tiktok/test_tools.py open_file_manager --serial emulator-5554
"""
import argparse, asyncio, logging, sys
from pathlib import Path

# Ensure the project root is on sys.path so that "apps" and "mobilerun" can be
# imported regardless of which directory the script is invoked from.
_project_root = str(Path(__file__).parents[2])
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

from dotenv import load_dotenv
load_dotenv()

from async_adbutils import adb
from mobilerun.agent.action_context import ActionContext
from mobilerun.agent.droid.state import MobileAgentState
from mobilerun.tools.driver.android import AndroidDriver
from mobilerun.tools.filters import DetailedFilter
from mobilerun.tools.formatters import IndexedFormatter
from mobilerun.tools.ui.provider import AndroidStateProvider

from apps.tiktok.tools import (
    open_file_manager_at_video,
    share_video_file_to_tiktok,
    complete_video_upload,
    download_video_to_device,
)

async def build_ctx(serial=None):
    if serial is None:
        devices = await adb.list()
        if not devices:
            raise RuntimeError("No connected Android devices found.")
        serial = devices[0].serial
    driver = AndroidDriver(serial=serial)
    await driver.connect()
    state_provider = AndroidStateProvider(
        driver,
        tree_filter=DetailedFilter(),
        tree_formatter=IndexedFormatter(),
    )
    ui_state = await state_provider.get_state()
    shared_state = MobileAgentState()
    return ActionContext(
        driver=driver,
        ui=ui_state,
        shared_state=shared_state,
        state_provider=state_provider,
    )

async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("tool", choices=["open_file_manager", "share_video", "complete_upload", "download_video"])
    parser.add_argument("--serial", default=None)
    parser.add_argument("--url", default=None, help="Video URL for download_video")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, stream=sys.stdout,
                        format="%(asctime)s [%(levelname)s] %(message)s")

    ctx = await build_ctx(args.serial)

    if args.tool == "open_file_manager":
        result = await open_file_manager_at_video(ctx=ctx)
    elif args.tool == "share_video":
        result = await share_video_file_to_tiktok(ctx=ctx)
    elif args.tool == "complete_upload":
        result = await complete_video_upload(ctx=ctx)
    elif args.tool == "download_video":
        if not args.url:
            print("--url is required for download_video"); sys.exit(1)
        result = await download_video_to_device(args.url, ctx=ctx)

    print(f"\n{'✅' if not result.startswith('Failed') else '❌'} Result: {result}")

asyncio.run(main())
