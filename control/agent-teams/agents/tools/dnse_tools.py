"""DNSE Open API Tools.

Implements all DNSE Open API endpoints (Trading & Market Data) as an Agno Toolkit
so that per-user API credentials can be injected at runtime via the tools registry.

Authentication uses an HTTP Signature scheme:
  - x-api-key   : the user's API key
  - Date        : current UTC datetime in RFC 2822 format
  - X-Signature : Signature keyId=...,algorithm=...,headers=...,signature=...
                  where the signature covers (request-target) and the Date header,
                  computed as HMAC-SHA256 (or another algorithm) of the signature string.

Reference: https://developers.dnse.com.vn
"""

import json
import logging
import os
from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

import httpx
from agno.tools import Toolkit, tool

from .common import build_signature, get_date_header_name

logger = logging.getLogger(__name__)

_BASE_URL = "https://openapi.dnse.com.vn"


class DnseTools(Toolkit):
    """Toolkit for interacting with the DNSE Open API.

    Parameters
    ----------
    api_key:
        DNSE API Key.
    api_secret:
        DNSE API Secret used to generate the HMAC-SHA256 request signature.
    """

    def __init__(
        self,
        api_key: str,
        api_secret: str,
        algorithm: str = "hmac-sha256",
        hmac_nonce_enabled: bool = True,
    ) -> None:
        super().__init__(name="dnse_tools")
        self._api_key = api_key
        self._api_secret = api_secret
        self._algorithm = algorithm
        self._hmac_nonce_enabled = hmac_nonce_enabled

        # Register all tools
        self.register(self.get_accounts)
        self.register(self.get_account_balances)
        self.register(self.get_loan_packages)
        self.register(self.get_ppse)
        self.register(self.get_deals)
        self.register(self.get_orders)
        self.register(self.get_order_detail)
        self.register(self.place_order)
        self.register(self.replace_order)
        self.register(self.cancel_order)
        self.register(self.get_orders_history)
        self.register(self.send_email_otp)
        self.register(self.get_trading_token)
        self.register(self.get_security_definition)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _auth_headers(self, method: str, path: str) -> dict:
        """Build authentication headers required by DNSE Open API.

        Generates an HTTP Signature over the request-target and date header,
        optionally including a nonce for replay-attack prevention.
        """
        date_header_name = get_date_header_name()
        date_value = datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S %z")
        nonce = uuid4().hex if self._hmac_nonce_enabled else None

        headers_list, signature = build_signature(
            self._api_secret,
            method,
            path,
            date_value,
            self._algorithm,
            nonce=nonce,
            header_name=date_header_name,
        )
        signature_header_value = (
            f'Signature keyId="{self._api_key}",algorithm="{self._algorithm}",'
            f'headers="{headers_list}",signature="{signature}"'
        )
        if nonce:
            signature_header_value += f',nonce="{nonce}"'

        return {
            date_header_name: date_value,
            "X-Signature": signature_header_value,
            "x-api-key": self._api_key,
        }

    def _get(self, path: str, params: Optional[dict] = None, extra_headers: Optional[dict] = None) -> str:
        """Execute an authenticated GET request and return a formatted string."""
        headers = self._auth_headers("GET", path)
        if extra_headers:
            headers.update(extra_headers)
        url = f"{_BASE_URL}{path}"
        try:
            resp = httpx.get(url, params=params, headers=headers, timeout=30)
            return self._format_response(resp)
        except httpx.RequestError as exc:
            return f"Request error: {exc}"

    def _post(self, path: str, body: Optional[dict] = None, extra_headers: Optional[dict] = None) -> str:
        """Execute an authenticated POST request and return a formatted string."""
        headers = self._auth_headers("POST", path)
        headers["Content-Type"] = "application/json"
        if extra_headers:
            headers.update(extra_headers)
        url = f"{_BASE_URL}{path}"
        try:
            resp = httpx.post(url, json=body or {}, headers=headers, timeout=30)
            return self._format_response(resp)
        except httpx.RequestError as exc:
            return f"Request error: {exc}"

    def _put(self, path: str, body: Optional[dict] = None, extra_headers: Optional[dict] = None) -> str:
        """Execute an authenticated PUT request and return a formatted string."""
        headers = self._auth_headers("PUT", path)
        headers["Content-Type"] = "application/json"
        if extra_headers:
            headers.update(extra_headers)
        url = f"{_BASE_URL}{path}"
        try:
            resp = httpx.put(url, json=body or {}, headers=headers, timeout=30)
            return self._format_response(resp)
        except httpx.RequestError as exc:
            return f"Request error: {exc}"

    def _delete(self, path: str, extra_headers: Optional[dict] = None) -> str:
        """Execute an authenticated DELETE request and return a formatted string."""
        headers = self._auth_headers("DELETE", path)
        if extra_headers:
            headers.update(extra_headers)
        url = f"{_BASE_URL}{path}"
        try:
            resp = httpx.delete(url, headers=headers, timeout=30)
            return self._format_response(resp)
        except httpx.RequestError as exc:
            return f"Request error: {exc}"

    @staticmethod
    def _format_response(resp: httpx.Response) -> str:
        """Format an httpx response as a readable string."""
        try:
            data = resp.json()
            return json.dumps(data, ensure_ascii=False, indent=2)
        except Exception:
            return resp.text

    # ------------------------------------------------------------------
    # Trading Account
    # ------------------------------------------------------------------

    @tool
    def get_accounts(self) -> str:
        """Lấy danh sách tiểu khoản giao dịch của khách hàng (Get trading accounts).

        Returns the list of sub-accounts associated with the authenticated customer,
        including account ID, deal account flag, derivative account flag, and status.
        """
        return self._get("/accounts")

    @tool
    def get_account_balances(self, account_no: str) -> str:
        """Lấy thông tin số dư tiền, tài sản và định giá tài khoản (Get account balances).

        Returns cash balance, withdrawable cash, stock valuation, total assets,
        and net asset value for the specified account.

        Args:
            account_no: Mã tiểu khoản (sub-account number), e.g. "0123456789".
        """
        return self._get(f"/accounts/{account_no}/balances")

    @tool
    def get_loan_packages(
        self,
        account_no: str,
        market_type: Optional[str] = None,
        symbol: Optional[str] = None,
    ) -> str:
        """Lấy danh sách gói vay margin (Get available loan packages).

        Returns available margin loan packages with their IDs, names, and interest rates.

        Args:
            account_no: Mã tiểu khoản (sub-account number).
            market_type: Loại thị trường, e.g. "stock" or "derivative" (optional).
            symbol: Mã chứng khoán để lọc gói vay, e.g. "VNM" (optional).
        """
        params: dict = {}
        if market_type:
            params["marketType"] = market_type
        if symbol:
            params["symbol"] = symbol
        return self._get(f"/accounts/{account_no}/loan-packages", params=params or None)

    @tool
    def get_ppse(self, account_no: str) -> str:
        """Lấy sức mua và sức bán của tài khoản (Get buying and selling power).

        Returns the purchasing power (PP) and selling power (SE) for the
        specified account.

        Args:
            account_no: Mã tiểu khoản (sub-account number).
        """
        return self._get(f"/accounts/{account_no}/ppse")

    @tool
    def get_deals(self, account_no: str, market_type: str = "STOCK") -> str:
        """Lấy danh sách deal đang nắm giữ (Get open positions / held deals).

        Returns all open positions (deals) currently held in the specified account.

        Use ``market_type="STOCK"`` (default) for cơ sở (equity) deals, or
        ``market_type="DERIVATIVE"`` for phái sinh (derivative / futures) deals.

        Args:
            account_no: Mã tiểu khoản (sub-account number).
            market_type: Loại thị trường – "STOCK" (mặc định, cổ phiếu cơ sở)
                hoặc "DERIVATIVE" (phái sinh). Defaults to "STOCK".
        """
        return self._get(f"/accounts/{account_no}/deals", params={"marketType": market_type})

    # ------------------------------------------------------------------
    # Orders
    # ------------------------------------------------------------------

    @tool
    def get_orders(
        self,
        account_no: str,
        market_type: Optional[str] = None,
        order_category: Optional[str] = None,
    ) -> str:
        """Lấy sổ lệnh của tài khoản (Get order book).

        Returns all orders placed for the specified account during the current session.

        Args:
            account_no: Mã tiểu khoản (sub-account number).
            market_type: Loại thị trường, e.g. "stock" or "derivative" (optional).
            order_category: Loại danh mục lệnh, e.g. "normal" or "conditional" (optional).
        """
        params: dict = {}
        if market_type:
            params["marketType"] = market_type
        if order_category:
            params["orderCategory"] = order_category
        return self._get(f"/accounts/{account_no}/orders", params=params or None)

    @tool
    def get_order_detail(self, account_no: str, order_id: str) -> str:
        """Lấy chi tiết một lệnh giao dịch (Get order detail).

        Returns the full details of a specific order by its ID.

        Args:
            account_no: Mã tiểu khoản (sub-account number).
            order_id: Mã lệnh giao dịch (order ID).
        """
        return self._get(f"/accounts/{account_no}/orders/{order_id}")

    @tool
    def place_order(
        self,
        account_no: str,
        symbol: str,
        side: str,
        order_type: str,
        quantity: int,
        price: float,
        trading_token: str,
        loan_package_id: Optional[str] = None,
        order_category: Optional[str] = None,
        stop_price: Optional[float] = None,
    ) -> str:
        """Đặt lệnh mua hoặc bán chứng khoán (Place a buy or sell order).

        Submits a new trading order. Requires a valid trading token obtained
        via ``get_trading_token``.

        Args:
            account_no: Mã tiểu khoản (sub-account number).
            symbol: Mã chứng khoán, e.g. "VNM".
            side: Chiều lệnh – "NB" (mua/buy) or "NS" (bán/sell).
            order_type: Loại lệnh – "LO" (limit), "MP" (market), "ATO", "ATC", v.v.
            quantity: Số lượng cổ phiếu (number of shares, must be positive integer).
            price: Giá lệnh (order price).
            trading_token: Trading token lấy từ ``get_trading_token``.
            loan_package_id: Mã gói vay (optional, for margin orders).
            order_category: Loại danh mục lệnh (optional).
            stop_price: Giá dừng lỗ cho lệnh điều kiện (optional stop-loss price).
        """
        body: dict = {
            "accountNo": account_no,
            "symbol": symbol,
            "side": side,
            "orderType": order_type,
            "quantity": quantity,
            "price": price,
        }
        if loan_package_id:
            body["loanPackageId"] = loan_package_id
        if order_category:
            body["orderCategory"] = order_category
        if stop_price is not None:
            body["stopPrice"] = stop_price
        return self._post("/orders", body=body, extra_headers={"trading-token": trading_token})

    @tool
    def replace_order(
        self,
        account_no: str,
        order_id: str,
        price: Optional[float] = None,
        quantity: Optional[int] = None,
    ) -> str:
        """Sửa giá hoặc khối lượng của một lệnh chưa khớp (Modify an open order).

        Updates the price and/or quantity of an existing unmatched order.

        Args:
            account_no: Mã tiểu khoản (sub-account number).
            order_id: Mã lệnh cần sửa (order ID to modify).
            price: Giá mới (new price, optional).
            quantity: Khối lượng mới (new quantity, optional).
        """
        body: dict = {}
        if price is not None:
            body["price"] = price
        if quantity is not None:
            body["quantity"] = quantity
        return self._put(f"/accounts/{account_no}/orders/{order_id}", body=body)

    @tool
    def cancel_order(self, account_no: str, order_id: str) -> str:
        """Hủy một lệnh giao dịch chưa khớp (Cancel an open order).

        Cancels an existing unmatched order by its ID.

        Args:
            account_no: Mã tiểu khoản (sub-account number).
            order_id: Mã lệnh cần hủy (order ID to cancel).
        """
        return self._delete(f"/accounts/{account_no}/orders/{order_id}")

    @tool
    def get_orders_history(self, account_no: str) -> str:
        """Lấy lịch sử lệnh giao dịch (Get order history).

        Returns the full historical record of orders placed for the specified account.

        Args:
            account_no: Mã tiểu khoản (sub-account number).
        """
        return self._get(f"/accounts/{account_no}/orders/history")

    # ------------------------------------------------------------------
    # Authentication
    # ------------------------------------------------------------------

    @tool
    def send_email_otp(self) -> str:
        """Gửi mã OTP qua email để xác thực giao dịch (Send Email OTP).

        Triggers DNSE to send a one-time password to the registered email address.
        Use the received OTP with ``get_trading_token`` to obtain a trading token.
        """
        return self._post("/registration/send-email-otp")

    @tool
    def get_trading_token(self, passcode: str, otp_type: str = "email_otp") -> str:
        """Xác thực OTP và lấy Trading Token (Verify OTP and get Trading Token).

        Exchanges an OTP passcode for a short-lived trading token that is required
        to place orders via ``place_order``.

        Args:
            passcode: Mã OTP nhận được qua email (OTP code received by email).
            otp_type: Loại OTP – mặc định là "email_otp" (default "email_otp").
        """
        return self._post(
            "/registration/trading-token",
            body={"otpType": otp_type, "passcode": passcode},
        )

    # ------------------------------------------------------------------
    # Market Data
    # ------------------------------------------------------------------

    @tool
    def get_security_definition(
        self,
        symbol: str,
        board_id: Optional[int] = None,
    ) -> str:
        """Lấy thông tin định nghĩa mã chứng khoán (Get security definition).

        Returns market data for a stock symbol including basic price, ceiling price,
        floor price, security name, security type, ISIN, and tick size.

        Args:
            symbol: Mã chứng khoán, e.g. "VNM", "HPG", "VIC".
            board_id: Mã sàn (board identifier, optional).
        """
        params: dict = {}
        if board_id is not None:
            params["boardId"] = board_id
        return self._get(f"/price/secdef/{symbol}", params=params or None)
