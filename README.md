# F1GENZ CheckOrders Server

## Production checklist

- Chạy `npm run build` trước khi deploy.
- Bắt buộc có Redis production và bật persistence hoặc backup ở tầng hạ tầng.
- Dùng PostgreSQL + Prisma cho dữ liệu bền vững: `Shop`, `AppInstall`, `ShopSettings`, `SubscriptionSnapshot`, `WebhookEvent`, `LookupEvent`.
- Cấu hình `DATABASE_URL` (kết nối runtime của ứng dụng) và `DIRECT_URL` (kết nối trực tiếp cho `prisma migrate deploy`).
- Cấu hình `DATA_ENCRYPTION_KEY` (32 bytes AES-256-GCM để mã hóa OAuth token trong DB) và `LOOKUP_HASH_SECRET` (HMAC audit log).
- Cấu hình đúng `FRONTEND_URL`, `API_BASE_URL`, `WIDGET_API_URL`, `WIDGET_PUBLIC_URL`, `CORS_ALLOWED_ORIGINS`.
- Cấu hình đúng Haravan OAuth: authorize URL, token URL, client id, client secret, login callback, install callback.
- Cấu hình webhook subscription khi dùng sync trial hoặc billing: `HRV_WEBHOOK_URL`, `HRV_WEBHOOK_SECRET`, `HRV_WEBHOOK_AUTO_SUBSCRIBE=true`.
- Chạy `npx prisma migrate deploy` trước khi restart production.
- Kiểm tra `/api/health` sau deploy; Redis và database phải trả `ok`.
- Storefront chỉ dùng `public_shop`, không truyền secret hoặc token ra theme.

### 1. Fail-Closed Security Invariant (`clearTokensForUninstall`)
Khi nhận webhook gỡ ứng dụng (`app/uninstalled`), `clearTokensForUninstall` thực hiện giao dịch xóa toàn bộ OAuth ciphertext, IV, auth tag và refresh token trong cả 2 bảng `Shop` và `AppInstall` (`accessTokenCiphertext=null`, `accessTokenIv=null`, `accessTokenTag=null`, `refreshTokenCiphertext=null`, `refreshTokenIv=null`, `refreshTokenTag=null`, `tokenExpiresAt=null`, `isActive=false`, `status='uninstalled'`), đồng thời giữ lại lịch sử cửa hàng và cấu hình `ShopSettings` để phục vụ cài lại.
Nếu thao tác DB thất bại, hàm sẽ log error và **ném lỗi (`throw error`)** để webhook báo lỗi, ngăn chặn rò rỉ token không được xóa sạch.

### 2. Resilient Runtime Ingestion & Auditing
Redis đóng vai trò cache runtime chính cho phiên làm việc, tra cứu shop và rate limit. Các tác vụ ghi dữ liệu bổ trợ vào PostgreSQL:
- `upsertShop`, `upsertInstallSession`: Đồng bộ thông tin shop và phiên cài đặt vào DB.
- `upsertSubscription`: Cập nhật snapshot gói dịch vụ vào DB.
- `upsertSettings`: Lưu trữ bản sao cấu hình giao diện.
- `recordLookupEvent`, `recordWebhook`: Ghi nhật ký tra cứu (băm HMAC số điện thoại / mã đơn) và nhật ký sự kiện webhook.
Các hàm này được bọc `try / catch` và ghi log cảnh báo (`logger.warn`), đảm bảo sự cố gián đoạn tạm thời của DB không làm gián đoạn luồng tra cứu của khách hàng trên storefront hay luồng phản hồi API.
