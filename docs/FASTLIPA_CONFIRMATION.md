# FastLipa Integration — Confirmation & Architectural Specifications

This document outlines the verified market facts, unconfirmed provider specifications, and Windowseven internal architectural decisions regarding the FastLipa payment gateway integration.

---

## 1. Classification Guidelines

Every item in this document is categorized strictly under one of three headings:
* **VERIFIED**: Confirmed by authoritative FastLipa documentation or verified Tanzanian mobile money gateway technical specifications.
* **REQUIRES FASTLIPA CONFIRMATION**: Technical details, contracts, or business policies that are unconfirmed and must be officially provided by FastLipa before production deployment.
* **INTERNAL ARCHITECTURE DECISION**: Windowseven's internal engineering and security standards.

---

## 2. FastLipa Confirmation Checklist (19 Verification Points)

| # | Integration Area | Status | Documented Findings & Exact Requirements |
| :--- | :--- | :--- | :--- |
| **1** | **API Authentication Mechanism** | `REQUIRES FASTLIPA CONFIRMATION` | Public documentation does not definitively state whether FastLipa uses `Authorization: Bearer <token>`, HTTP Basic Authentication (`api_key` + `api_secret`), or custom headers (e.g. `X-Api-Key`). Must be confirmed via official developer docs. |
| **2** | **Payment Initiation Endpoint** | `REQUIRES FASTLIPA CONFIRMATION` | Exact URI path (e.g., `POST /v1/payments/create`, `POST /api/v1/charge`, or `/transactions/initiate`) is unconfirmed. |
| **3** | **Request Payload Fields** | `REQUIRES FASTLIPA CONFIRMATION` | Exact naming conventions (e.g., `phone` vs `customer_phone` vs `msisdn`; `amount` as integer in TZS or float; `callback_url` vs `webhook_url`) must be provided by FastLipa. |
| **4** | **Response Payload Fields** | `REQUIRES FASTLIPA CONFIRMATION` | Expected HTTP response body on transaction creation (e.g., returns provider transaction ID, USSD push confirmation status, or redirect link) must be confirmed. |
| **5** | **Transaction / Reference Model** | `REQUIRES FASTLIPA CONFIRMATION` | Does FastLipa accept and echo back our internal reference string (e.g., `WS-B4F1A9`), or does it generate its own reference that must be matched in the webhook? |
| **6** | **Webhook Endpoint Requirements** | `INTERNAL ARCHITECTURE DECISION` | Windowseven will expose a single public HTTPS endpoint: `POST /api/v1/payments/callback`. It will require TLS 1.2+ and respond with standard JSON. |
| **7** | **Webhook Authentication / Signature** | `REQUIRES FASTLIPA CONFIRMATION` | **Do NOT assume HMAC-SHA256.** FastLipa must confirm whether incoming webhooks include a cryptographic signature header (e.g., `X-Signature`), a shared bearer token, IP whitelisting, or require a separate server-side verification query. |
| **8** | **Webhook Retry Behavior** | `REQUIRES FASTLIPA CONFIRMATION` | If Windowseven's endpoint fails or times out, what is FastLipa's retry schedule (e.g., exponential backoff over 24 hours, fixed 5-minute intervals) and terminal drop condition? |
| **9** | **Transaction Status / Reconciliation API** | `REQUIRES FASTLIPA CONFIRMATION` | Does FastLipa provide a `GET /transactions/{reference}` status-check API to reconcile transactions when webhooks are delayed or dropped? |
| **10** | **Supported Payment Methods** | `VERIFIED` | Supports Tanzanian Mobile Network Operators: Vodacom M-Pesa, Tigo Pesa (Mixx by Yas), Airtel Money, and HaloPesa via push USSD prompts. Card payments require confirmation. |
| **11** | **KYC Requirements for Individuals / Sole Traders** | `REQUIRES FASTLIPA CONFIRMATION` | Can a sole trader or individual freelancer open a verified production merchant account, or is formal business registration mandatory? |
| **12** | **Is NIDA Alone Sufficient?** | `REQUIRES FASTLIPA CONFIRMATION` | Must confirm whether National ID (NIDA) number and card copy alone are sufficient for production onboarding. |
| **13** | **Is TIN / BRELA Registration Required?** | `REQUIRES FASTLIPA CONFIRMATION` | Confirm whether a Taxpayer Identification Number (TIN) and BRELA Business Name registration are mandatory to enable collections. |
| **14** | **Settlement Methods** | `REQUIRES FASTLIPA CONFIRMATION` | Does FastLipa disburse collected funds directly to a mobile money till/account (e.g. Lipa Kwa M-Pesa till) or strictly to commercial bank accounts (CRDB, NMB, etc.)? |
| **15** | **Settlement Timing** | `REQUIRES FASTLIPA CONFIRMATION` | Frequency of merchant payouts: real-time, daily (T+1), weekly, or manual on-demand withdrawal request. |
| **16** | **Transaction Fees** | `REQUIRES FASTLIPA CONFIRMATION` | Exact fee percentage per successful mobile money collection (e.g., 2%–3%) and whether fees are deducted from collection or billed separately. |
| **17** | **Failed Transaction Fees** | `REQUIRES FASTLIPA CONFIRMATION` | Are failed, timed-out, or user-cancelled USSD requests free of charge? (Standard practice in Tanzania is zero charge on failed transactions). |
| **18** | **Sandbox Availability** | `VERIFIED` | FastLipa provides developer testing environments with mock USSD approval capabilities for pre-production verification. |
| **19** | **Production Onboarding Requirements** | `REQUIRES FASTLIPA CONFIRMATION` | Timeframe, contract signing, and compliance review steps required to transition API keys from test to live mode. |

---

## 3. Windowseven Internal Architecture Standards

To prevent unconfirmed provider details from stalling development, Windowseven adopts these internal standards:

### 1. Zero Credential Exposure
* FastLipa credentials must exist strictly as server-side environment variables loaded via configuration:
  * FastLipa API endpoints, keys, and webhook secrets will be injected at runtime and never delivered to the client browser.
* Frontend code interacts solely with Windowseven's internal endpoints:
  * `POST /api/v1/me/subscriptions/purchase`
  * `GET /api/v1/me/payments`

### 2. Provider Abstraction Layer
* Core business logic interacts strictly through an internal interface (`PaymentGateway`):
  ```javascript
  class PaymentGateway {
      async initiatePayment({ amount, currency, customerPhone, reference }) {}
      async verifyWebhook(request) {}
      async getPaymentStatus(reference) {}
  }
  ```
* `FastLipaAdapter` will implement this interface. If FastLipa specifications change, modifications remain isolated inside `FastLipaAdapter` without touching subscription or customer logic.

### 3. Verification Fallback Defense
* If FastLipa does **not** provide cryptographic webhook signatures, Windowseven's `FastLipaAdapter` will enforce an active status check before activating a subscription:
  Upon receiving a webhook notification, the adapter immediately queries FastLipa's transaction status endpoint to verify that the transaction is genuinely marked `SUCCESS` on FastLipa's servers.
