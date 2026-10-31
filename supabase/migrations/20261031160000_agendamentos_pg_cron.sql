-- Tarefas automáticas (pg_cron, horários em UTC)
--   Radares: toda segunda às 04:17 reimporta DGT + OpenStreetMap (se uma fonte falhar, não desativa nada)
--   Avisos: todo dia às 03:41 apaga os avisos da comunidade já vencidos
-- Para desfazer: select cron.unschedule('blindacar-radares-semanal'); select cron.unschedule('blindacar-limpeza-diaria');
create extension if not exists pg_cron;

select cron.schedule('blindacar-radares-semanal', '17 4 * * 1',
  $$select public.import_radars();$$);

select cron.schedule('blindacar-limpeza-diaria', '41 3 * * *',
  $$select public.purge_old_reports();$$);
