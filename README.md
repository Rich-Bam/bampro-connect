# Peplink GPS Map (Supabase + Netlify)

## 1) Install Supabase CLI

```bash
brew install supabase/tap/supabase
```

## 2) Login and link project

```bash
supabase login
supabase link --project-ref bbivyjrlcqjfkabhjjap
```

## 3) Store Peplink credentials (Supabase Secrets)

```bash
supabase secrets set PEPLINK_CLIENT_ID="your_client_id"
supabase secrets set PEPLINK_CLIENT_SECRET="your_client_secret"
```

## 4) Deploy Edge Function

```bash
supabase functions deploy peplink-location
```

Edge Function URL:
```
https://bbivyjrlcqjfkabhjjap.functions.supabase.co/peplink-location
```

## 5) Deploy frontend to Netlify

Upload the repository root (with `index.html`) to Netlify.

Your custom domain:
```
https://www.bampro-connect.nl
```
