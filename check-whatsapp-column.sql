SELECT table_name, column_name FROM information_schema.columns
WHERE table_name IN ('partners','partner_applications') AND column_name = 'whatsapp_message';
