SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name IN ('partners','partner_applications','users','leads')
ORDER BY table_name;
