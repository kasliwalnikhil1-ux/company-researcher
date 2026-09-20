# Outreach RPC signatures (generated from the live database)

Generated from `pg_proc` on 2026-09-20 (after migrations 009–017). `user` = callable with a member JWT (the function still checks the role itself); `service` = workers / cron only. The anonymous role can call only `outreach_branding_for_host`, `outreach_branding_for_invite` and `outreach_invitation_preview`.
Call from the web app with `rpc('<name without outreach_>', args)`, from edge functions with `rpc()` (service) or `urpc()` (as the user), from the public API through `outreach_api_dispatch`.

| Function | Arguments | Returns | Caller |
|---|---|---|---|
| `outreach_ab_results` | `p_sequence uuid, p_node_id text, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date` | `jsonb` | user |
| `outreach_accept_invitation` | `p_token text` | `uuid` | user |
| `outreach_action_label` | `p_type text` | `text` | user |
| `outreach_add_domain` | `p_ws uuid, p_hostname text, p_client uuid DEFAULT NULL::uuid` | `jsonb` | user |
| `outreach_add_suppressions` | `p_ws uuid, p_rows jsonb, p_client uuid DEFAULT NULL::uuid, p_sequence uuid DEFAULT NULL::uuid, p_source text DEFAULT 'manual'::text` | `jsonb` | user |
| `outreach_add_tracking_domain` | `p_ws uuid, p_hostname text, p_sender uuid DEFAULT NULL::uuid` | `jsonb` | user |
| `outreach_advance_enrollment` | `p_enrollment uuid, p_from_node text, p_branch text DEFAULT NULL::text, p_not_before timestamp with time zone DEFAULT NULL::timestamp with time zone` | `void` | service |
| `outreach_agent_gc` | `` | `void` | service |
| `outreach_agent_node_queued_actions` | `p_sequence uuid, p_node_id text` | `TABLE(action_id uuid, lead_id uuid, sender_id uuid, payload jsonb, scheduled_for timestamp with time zone)` | user |
| `outreach_agent_reschedule_delay` | `p_sequence uuid, p_node_id text` | `TABLE(rescheduled integer, due_now integer)` | user |
| `outreach_agent_set_action_text` | `p_action uuid, p_text text` | `boolean` | user |
| `outreach_ai_claim_pending` | `p_limit integer DEFAULT 20` | `TABLE(value_id uuid, workspace_id uuid, lead_id uuid, variable_id uuid, key text, prompt text, fallback text, needs_posts boolean, max_chars integer, enriche…` | service |
| `outreach_ai_fail_exhausted` | `` | `integer` | service |
| `outreach_ai_generate_request` | `p_ws uuid, p_variable uuid, p_lead_ids uuid[], p_sequence uuid DEFAULT NULL::uuid, p_regenerate boolean DEFAULT false` | `jsonb` | user |
| `outreach_ai_review` | `p_value_ids uuid[], p_action text, p_text text DEFAULT NULL::text` | `jsonb` | user |
| `outreach_ai_review_list` | `p_ws uuid, p_batch uuid DEFAULT NULL::uuid, p_status text DEFAULT 'generated'::text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0` | `TABLE(value_id uuid, lead_id uuid, lead_name text, company text, title text, variable_key text, variable_name text, body text, facts jsonb, status text, edit…` | user |
| `outreach_ai_route_decide` | `p_enrollment uuid, p_node_id text, p_branch text, p_reason text, p_facts jsonb, p_model text` | `void` | service |
| `outreach_ai_route_pending` | `p_limit integer DEFAULT 20` | `TABLE(enrollment_id uuid, node_id text, workspace_id uuid, lead_id uuid, routes jsonb, attempts integer)` | service |
| `outreach_ai_value_result` | `p_id uuid, p_text text, p_facts jsonb, p_model text, p_error text DEFAULT NULL::text` | `void` | service |
| `outreach_api_authenticate` | `p_key text` | `jsonb` | service |
| `outreach_api_context` | `p_ws uuid` | `jsonb` | user |
| `outreach_api_deliveries` | `p_ws uuid, p_webhook uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 50` | `jsonb` | user |
| `outreach_api_dispatch` | `p_key_id uuid, p_fn text, p_args jsonb DEFAULT '{}'::jsonb` | `jsonb` | service |
| `outreach_api_enrollments` | `p_ws uuid, p_filters jsonb DEFAULT '{}'::jsonb, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0` | `jsonb` | user |
| `outreach_api_idempotent` | `p_key_id uuid, p_idem text, p_hash text, p_status integer DEFAULT NULL::integer, p_response jsonb DEFAULT NULL::jsonb` | `jsonb` | service |
| `outreach_api_lead` | `p_lead uuid` | `jsonb` | user |
| `outreach_api_leads` | `p_ws uuid, p_filters jsonb DEFAULT '{}'::jsonb, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0` | `jsonb` | user |
| `outreach_api_sender` | `p_sender uuid` | `jsonb` | user |
| `outreach_api_senders` | `p_ws uuid` | `jsonb` | user |
| `outreach_api_sequence` | `p_sequence uuid` | `jsonb` | user |
| `outreach_api_sequences` | `p_ws uuid, p_status text DEFAULT NULL::text, p_client uuid DEFAULT NULL::uuid` | `jsonb` | user |
| `outreach_api_thread` | `p_chat uuid, p_limit integer DEFAULT 100` | `jsonb` | user |
| `outreach_api_threads` | `p_ws uuid, p_filters jsonb DEFAULT '{}'::jsonb, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0` | `jsonb` | user |
| `outreach_api_webhooks` | `p_ws uuid` | `jsonb` | user |
| `outreach_apply_reply_intent` | `p_message uuid, p_intent outreach_intent_t, p_return_date date DEFAULT NULL::date` | `jsonb` | service |
| `outreach_assign_chat` | `p_chat uuid, p_user uuid` | `void` | user |
| `outreach_audit` | `p_ws uuid, p_action text, p_entity text, p_entity_id text, p_diff jsonb DEFAULT NULL::jsonb, p_actor_type text DEFAULT NULL::text` | `void` | user |
| `outreach_branding` | `p_ws uuid` | `jsonb` | user |
| `outreach_branding_for_host` | `p_hostname text` | `jsonb` | user |
| `outreach_branding_for_invite` | `p_token text` | `jsonb` | user |
| `outreach_bulk_leads` | `p_ws uuid, p_lead_ids uuid[], p_op text, p_value text DEFAULT NULL::text` | `integer` | user |
| `outreach_can_manage` | `ws uuid` | `boolean` | user |
| `outreach_can_write` | `ws uuid` | `boolean` | user |
| `outreach_claim_due_actions` | `p_limit integer DEFAULT 200` | `SETOF outreach_actions` | service |
| `outreach_clean_domain` | `p text` | `text` | user |
| `outreach_client_stats` | `p_client uuid` | `jsonb` | user |
| `outreach_client_visible` | `ws uuid, cid uuid` | `boolean` | user |
| `outreach_complete_action` | `p_id uuid, p_response jsonb DEFAULT NULL::jsonb, p_branch text DEFAULT NULL::text` | `void` | service |
| `outreach_complete_enrollment` | `p_id uuid, p_status outreach_enrollment_status_t, p_reason text` | `void` | service |
| `outreach_complete_task` | `p_id uuid, p_text text DEFAULT NULL::text, p_result jsonb DEFAULT NULL::jsonb` | `void` | user |
| `outreach_consume_budget` | `p_sender uuid, p_day date, p_type outreach_action_type_t` | `void` | service |
| `outreach_create_api_key` | `p_ws uuid, p_name text, p_role outreach_role_t DEFAULT 'member'::outreach_role_t, p_client_ids uuid[] DEFAULT '{}'::uuid[], p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone` | `jsonb` | user |
| `outreach_create_node_task` | `p_e outreach_enrollments, p_node jsonb, p_kind outreach_task_kind_t` | `uuid` | service |
| `outreach_create_sequence` | `p_workspace uuid, p_name text, p_client_id uuid DEFAULT NULL::uuid` | `uuid` | user |
| `outreach_create_webhook` | `p_ws uuid, p_url text, p_events text[]` | `jsonb` | user |
| `outreach_create_workspace` | `p_name text` | `outreach_workspaces` | user |
| `outreach_crm_should_sync` | `p_integration uuid, p_lead uuid` | `boolean` | service |
| `outreach_dashboard` | `p_ws uuid` | `jsonb` | user |
| `outreach_delete_auto_enroll_rule` | `p_id uuid` | `void` | user |
| `outreach_delete_node_inflight` | `p_sequence uuid, p_node_id text, p_mode text` | `integer` | user |
| `outreach_delete_webhook` | `p_id uuid` | `void` | user |
| `outreach_detect_stalls` | `` | `jsonb` | service |
| `outreach_discard_draft` | `p_id uuid` | `void` | user |
| `outreach_domains` | `p_ws uuid` | `jsonb` | user |
| `outreach_effective_cap` | `p_sender uuid, p_type outreach_action_type_t` | `integer` | user |
| `outreach_effective_cap_checked` | `p_sender uuid, p_type outreach_action_type_t` | `integer` | user |
| `outreach_emit_event` | `p_ws uuid, p_event text, p_payload jsonb` | `void` | service |
| `outreach_enrich_allowance` | `p_sender uuid, p_priority boolean DEFAULT false` | `integer` | service |
| `outreach_enrich_done` | `p_lead uuid, p_sender uuid, p_ok boolean, p_error text, p_background boolean` | `void` | service |
| `outreach_enrich_next` | `p_sender uuid, p_limit integer` | `TABLE(lead_id uuid, want_posts boolean, priority boolean, provider_id text, public_identifier text)` | service |
| `outreach_enroll_leads` | `p_sequence uuid, p_lead_ids uuid[], p_sender uuid DEFAULT NULL::uuid, p_priority integer DEFAULT 100, p_include_replied boolean DEFAULT false, p_rule uuid DEFAULT NULL::uuid, p_wait_enrichment boolean DEFAULT NULL::boolean` | `TABLE(enrolled integer, skipped_active integer, skipped_suppressed integer, skipped_other integer, skipped_replied integer, waiting integer)` | user |
| `outreach_enroll_preview` | `p_sequence uuid, p_lead_ids uuid[], p_sender uuid DEFAULT NULL::uuid, p_include_replied boolean DEFAULT false` | `jsonb` | user |
| `outreach_enrollment_graph` | `p_enrollment uuid` | `jsonb` | user |
| `outreach_enrollment_recover` | `p_enrollment_ids uuid[], p_action text` | `jsonb` | user |
| `outreach_enrollment_reply_blocked` | `p_enrollment uuid, p_action_sender uuid DEFAULT NULL::uuid` | `boolean` | service |
| `outreach_enrollment_suppression_reason` | `p_enrollment uuid` | `text` | service |
| `outreach_ensure_ai_values` | `p_ws uuid, p_lead uuid, p_keys text[], p_batch uuid` | `integer` | service |
| `outreach_ensure_workspace` | `p_name text DEFAULT NULL::text` | `outreach_workspaces` | user |
| `outreach_enter_node` | `p_enrollment uuid, p_node_id text, p_not_before timestamp with time zone DEFAULT NULL::timestamp with time zone` | `void` | service |
| `outreach_eval_condition` | `p_config jsonb, p_lead_id uuid, p_sender_id uuid` | `boolean` | user |
| `outreach_eval_rule` | `p_rule jsonb, p_lead outreach_leads, p_lss outreach_lead_sender_state, p_sender outreach_senders` | `boolean` | user |
| `outreach_exit_enrollment` | `p_id uuid, p_reason text DEFAULT 'manual'::text` | `void` | user |
| `outreach_fail_action` | `p_id uuid, p_code text, p_decision text, p_retry_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_branch text DEFAULT NULL::text` | `void` | service |
| `outreach_failed_leads` | `p_sequence uuid, p_node_id text DEFAULT NULL::text, p_kind text DEFAULT 'failed'::text, p_limit integer DEFAULT 200, p_offset integer DEFAULT 0` | `TABLE(enrollment_id uuid, lead_id uuid, lead_name text, company text, sender_id uuid, sender_name text, node_id text, error_code text, reason text, at timest…` | user |
| `outreach_failed_summary` | `p_sequence uuid` | `TABLE(node_id text, reason text, error_code text, leads integer, recoverable integer, oldest timestamp with time zone)` | user |
| `outreach_graph_change_count` | `p_old jsonb, p_new jsonb` | `integer` | user |
| `outreach_graph_diff` | `p_old jsonb, p_new jsonb` | `TABLE(node_id text, change text, text_changed boolean, delay_changed boolean, node_type text)` | user |
| `outreach_graph_step_numbers` | `p_graph jsonb` | `jsonb` | user |
| `outreach_health_inputs` | `p_sender uuid` | `jsonb` | service |
| `outreach_hold_enrollment` | `p_id uuid, p_reason text` | `void` | service |
| `outreach_import_conversations` | `p_job uuid` | `jsonb` | service |
| `outreach_in_schedule` | `p_sender uuid, p_at timestamp with time zone` | `boolean` | user |
| `outreach_inmail_guard` | `p_sender uuid, p_day date` | `integer` | service |
| `outreach_integration_disconnect` | `p_id uuid` | `void` | user |
| `outreach_integration_save` | `p_id uuid, p_settings jsonb DEFAULT NULL::jsonb, p_field_mapping jsonb DEFAULT NULL::jsonb, p_stage_mapping jsonb DEFAULT NULL::jsonb` | `void` | user |
| `outreach_invitation_preview` | `p_token text` | `TABLE(workspace_name text, email citext, role outreach_role_t, expired boolean, accepted boolean)` | user |
| `outreach_invoke` | `p_name text, p_body jsonb DEFAULT '{}'::jsonb` | `bigint` | service |
| `outreach_is_executable_node` | `p_type text` | `boolean` | user |
| `outreach_is_service` | `` | `boolean` | user |
| `outreach_issue_sender_token` | `p_sender uuid` | `text` | user |
| `outreach_lead_ai_facts` | `p_lead uuid` | `jsonb` | service |
| `outreach_lead_enrich_ctx` | `p_lead uuid` | `jsonb` | service |
| `outreach_lead_is_suppressed` | `p_lead outreach_leads` | `boolean` | user |
| `outreach_lead_queued_actions` | `p_lead uuid` | `TABLE(action_id uuid, enrollment_id uuid, sequence_id uuid, sequence_name text, node_id text, node_label text, action_type outreach_action_type_t, sender_id …` | user |
| `outreach_lead_suppression_reason` | `p_lead outreach_leads, p_client uuid DEFAULT NULL::uuid, p_sequence uuid DEFAULT NULL::uuid` | `text` | user |
| `outreach_lead_timeline` | `p_lead uuid` | `TABLE(at timestamp with time zone, kind text, title text, data jsonb)` | user |
| `outreach_mark_alerts_notified` | `p_ids uuid[]` | `void` | service |
| `outreach_metric_definitions` | `` | `jsonb` | user |
| `outreach_move_to_latest` | `p_sequence uuid, p_version integer` | `jsonb` | user |
| `outreach_my_workspaces` | `` | `TABLE(id uuid, name text, slug text, plan text, role outreach_role_t, client_ids uuid[], can_reply boolean, settings jsonb, trial_ends_at timestamp with time…` | user |
| `outreach_node_action_type` | `p_type text` | `outreach_action_type_t` | user |
| `outreach_node_config_for` | `p_enrollment uuid, p_node jsonb` | `jsonb` | user |
| `outreach_node_queued_actions` | `p_sequence uuid, p_node_id text` | `TABLE(action_id uuid, lead_id uuid, lead_name text, sender_id uuid, payload jsonb, scheduled_for timestamp with time zone, variant_id text)` | user |
| `outreach_node_types` | `` | `text[]` | user |
| `outreach_norm_cdf` | `z numeric` | `numeric` | user |
| `outreach_pause_enrollment` | `p_id uuid` | `void` | user |
| `outreach_pause_sender` | `p_sender uuid, p_pause boolean` | `void` | user |
| `outreach_pick_mailbox` | `p_enrollment uuid, p_node jsonb` | `uuid` | service |
| `outreach_pick_variant` | `p_enrollment uuid, p_node_id text, p_variants jsonb` | `text` | user |
| `outreach_plan_active` | `ws uuid` | `boolean` | user |
| `outreach_plan_budgets` | `p_sender uuid, p_day date` | `SETOF outreach_sender_budgets` | service |
| `outreach_planner_demand` | `p_sender uuid, p_until timestamp with time zone` | `TABLE(enrollment_id uuid, lead_id uuid, sequence_id uuid, node_id text, node jsonb, action_type outreach_action_type_t, earliest timestamp with time zone, pr…` | service |
| `outreach_project_sequence` | `p_sequence uuid, p_lead_count integer` | `TABLE(estimated_days integer, bottleneck outreach_action_type_t, details jsonb)` | user |
| `outreach_promote_variant` | `p_sequence uuid, p_node_id text, p_variant text` | `jsonb` | user |
| `outreach_publish_impact` | `p_id uuid, p_graph jsonb DEFAULT NULL::jsonb` | `jsonb` | user |
| `outreach_publish_sequence` | `p_id uuid, p_graph jsonb DEFAULT NULL::jsonb, p_mode text DEFAULT 'all'::text, p_note text DEFAULT NULL::text, p_force boolean DEFAULT false, p_update_queued boolean DEFAULT false, p_reschedule_delays boolean DEFAULT false, p_removed_mode text DEFAULT 'skip'::text, p_pool uuid[] DEFAULT NULL::uuid[], p_settings jsonb DEFAULT NULL::jsonb, p_name text DEFAULT NULL::text, p_assignment text DEFAULT NULL::text, p_brief text DEFAULT NULL::text, p_use_sender_schedule boolean DEFAULT NULL::boolean, p_client_id uuid DEFAULT NULL::uuid` | `jsonb` | user |
| `outreach_queue_action` | `p_enrollment uuid, p_node_id text, p_type outreach_action_type_t, p_scheduled_for timestamp with time zone, p_payload jsonb DEFAULT '{}'::jsonb, p_sender uuid DEFAULT NULL::uuid, p_lead uuid DEFAULT NULL::uuid, p_import_job uuid DEFAULT NULL::uuid, p_workspace uuid DEFAULT NULL::uuid` | `uuid` | service |
| `outreach_rate_limit` | `p_key text, p_limit integer, p_window_secs integer` | `boolean` | service |
| `outreach_reason_text` | `p_code text, p_decision text DEFAULT NULL::text` | `text` | user |
| `outreach_rebalance_preview` | `p_sequence uuid, p_pool uuid[] DEFAULT NULL::uuid[]` | `jsonb` | user |
| `outreach_record_booking` | `p_ws uuid, p_provider text, p_external_id text, p_lead uuid, p_email text, p_status text, p_starts_at timestamp with time zone, p_payload jsonb, p_sender uuid DEFAULT NULL::uuid` | `jsonb` | service |
| `outreach_record_milestone` | `p_lead uuid, p_kind text, p_source text, p_value numeric DEFAULT NULL::numeric, p_currency text DEFAULT NULL::text` | `void` | service |
| `outreach_refresh_queued_text` | `p_sequence uuid, p_node_id text` | `integer` | user |
| `outreach_release_budget` | `p_sender uuid, p_day date, p_type outreach_action_type_t` | `void` | service |
| `outreach_release_waiting` | `p_lead uuid, p_reason text` | `integer` | service |
| `outreach_release_waits` | `` | `integer` | service |
| `outreach_remove_domain` | `p_id uuid` | `void` | user |
| `outreach_remove_member` | `p_ws uuid, p_user uuid` | `void` | user |
| `outreach_remove_tracking_domain` | `p_id uuid` | `void` | user |
| `outreach_render_context` | `p_lead uuid, p_sender uuid DEFAULT NULL::uuid, p_enrollment uuid DEFAULT NULL::uuid` | `jsonb` | user |
| `outreach_replay_delivery` | `p_delivery bigint` | `bigint` | user |
| `outreach_report_client` | `p_client uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date` | `jsonb` | user |
| `outreach_report_clients` | `p_ws uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date` | `jsonb` | user |
| `outreach_report_cost` | `p_ws uuid, p_client uuid DEFAULT NULL::uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date` | `jsonb` | user |
| `outreach_report_funnel` | `p_ws uuid, p_client uuid DEFAULT NULL::uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_filters jsonb DEFAULT '{}'::jsonb` | `jsonb` | user |
| `outreach_report_intents` | `p_ws uuid, p_client uuid DEFAULT NULL::uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_group text DEFAULT 'day'::text, p_filters jsonb DEFAULT '{}'::jsonb` | `jsonb` | user |
| `outreach_report_overview` | `p_ws uuid, p_client uuid DEFAULT NULL::uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_filters jsonb DEFAULT '{}'::jsonb` | `jsonb` | user |
| `outreach_report_reply_threads` | `p_ws uuid, p_client uuid DEFAULT NULL::uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_intent text DEFAULT NULL::text, p_filters jsonb DEFAULT '{}'::jsonb` | `TABLE(chat_id uuid, lead_id uuid, lead_name text, sender_id uuid, intent text, replied_at timestamp with time zone, sequence_id uuid, node_id text, variant_i…` | user |
| `outreach_report_sender` | `p_sender uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date` | `jsonb` | user |
| `outreach_report_senders` | `p_ws uuid, p_client uuid DEFAULT NULL::uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date` | `jsonb` | user |
| `outreach_report_sequence` | `p_sequence uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date` | `jsonb` | user |
| `outreach_report_sequences` | `p_ws uuid, p_client uuid DEFAULT NULL::uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date` | `jsonb` | user |
| `outreach_request_enrichment` | `p_ws uuid, p_lead_ids uuid[], p_want_posts boolean DEFAULT false, p_force boolean DEFAULT false, p_reason text DEFAULT 'manual'::text` | `jsonb` | user |
| `outreach_requeue_sender_failures` | `p_sender uuid` | `integer` | service |
| `outreach_require` | `ws uuid, p_min text` | `void` | user |
| `outreach_reschedule_action` | `p_action uuid, p_at timestamp with time zone` | `void` | user |
| `outreach_reschedule_delay` | `p_sequence uuid, p_node_id text` | `TABLE(rescheduled integer, due_now integer)` | user |
| `outreach_reserve_budget` | `p_sender uuid, p_day date, p_type outreach_action_type_t` | `boolean` | service |
| `outreach_restore_sequence_version` | `p_id uuid, p_version integer` | `integer` | user |
| `outreach_resume_after_billing` | `p_ws uuid` | `integer` | service |
| `outreach_resume_enrollment` | `p_id uuid` | `void` | user |
| `outreach_revoke_api_key` | `p_id uuid` | `void` | user |
| `outreach_role_in` | `ws uuid` | `outreach_role_t` | user |
| `outreach_rollup_all` | `` | `integer` | service |
| `outreach_rollup_daily` | `p_ws uuid, p_from date, p_to date` | `integer` | service |
| `outreach_rule_match_count` | `p_rule uuid` | `integer` | user |
| `outreach_run_auto_enroll` | `p_rule uuid DEFAULT NULL::uuid` | `jsonb` | service |
| `outreach_run_import_schedules` | `` | `integer` | service |
| `outreach_save_auto_enroll_rule` | `p_rule jsonb` | `uuid` | user |
| `outreach_save_draft` | `p_id uuid, p_graph jsonb` | `jsonb` | user |
| `outreach_save_import_schedule` | `p jsonb` | `uuid` | user |
| `outreach_save_lead_posts` | `p_lead uuid, p_posts jsonb, p_sender uuid` | `void` | service |
| `outreach_save_lead_profile` | `p_lead uuid, p_profile jsonb, p_sender uuid, p_source text` | `jsonb` | service |
| `outreach_save_range` | `p_ws uuid, p_name text, p_preset text DEFAULT NULL::text, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date` | `uuid` | user |
| `outreach_save_sequence` | `p_id uuid, p_graph jsonb, p_pool uuid[] DEFAULT NULL::uuid[], p_settings jsonb DEFAULT NULL::jsonb, p_name text DEFAULT NULL::text, p_assignment text DEFAULT NULL::text, p_use_sender_schedule boolean DEFAULT NULL::boolean, p_client_id uuid DEFAULT NULL::uuid, p_brief text DEFAULT NULL::text` | `integer` | user |
| `outreach_save_voice_clip` | `p_sequence uuid, p_node_id text, p_sender uuid, p_path text, p_mime text, p_duration numeric, p_size integer` | `void` | user |
| `outreach_schedule_windows` | `p_sender uuid, p_day date` | `TABLE(start_at timestamp with time zone, end_at timestamp with time zone)` | user |
| `outreach_seed_workspace_defaults` | `p_ws uuid` | `void` | service |
| `outreach_sender_insights` | `p_sender uuid` | `jsonb` | user |
| `outreach_sender_local_date` | `p_sender uuid, p_at timestamp with time zone` | `date` | user |
| `outreach_sender_local_hour` | `p_sender uuid, p_at timestamp with time zone` | `integer` | user |
| `outreach_sender_today` | `p_sender uuid` | `jsonb` | user |
| `outreach_sequence_ai_keys` | `p_graph jsonb` | `text[]` | user |
| `outreach_sequence_chat_ids` | `p_sequence uuid` | `SETOF uuid` | user |
| `outreach_sequence_summary` | `p_ws uuid` | `TABLE(sequence_id uuid, live integer, completed integer, replied integer, sent integer, queued integer)` | user |
| `outreach_set_action_text` | `p_action uuid, p_text text, p_subject text DEFAULT NULL::text` | `boolean` | user |
| `outreach_set_branding` | `p_ws uuid, p_branding jsonb` | `jsonb` | user |
| `outreach_set_intent` | `p_chat uuid, p_intent outreach_intent_t` | `void` | user |
| `outreach_set_lead_email` | `p_lead uuid, p_email text, p_status text, p_source text` | `void` | service |
| `outreach_set_manual_caps` | `p_sender uuid, p_caps jsonb` | `void` | user |
| `outreach_set_pool` | `p_sequence uuid, p_pool uuid[], p_rebalance boolean DEFAULT false, p_contacted text DEFAULT 'keep'::text` | `jsonb` | user |
| `outreach_set_sender_schedule` | `p_sender uuid, p_schedule jsonb, p_timezone text` | `void` | user |
| `outreach_set_sequence_status` | `p_id uuid, p_status outreach_sequence_status_t, p_inflight text DEFAULT 'pause'::text` | `jsonb` | user |
| `outreach_set_updated_at` | `` | `trigger` | user |
| `outreach_set_webhook_active` | `p_id uuid, p_active boolean` | `void` | user |
| `outreach_skip_action` | `p_action uuid` | `void` | user |
| `outreach_slugify` | `p text` | `text` | user |
| `outreach_spintax_info` | `p_text text` | `TABLE(max_len integer, combinations bigint)` | user |
| `outreach_sweep_stale_reservations` | `` | `integer` | service |
| `outreach_template_max_len` | `p_text text` | `integer` | user |
| `outreach_thread_attribution` | `p_chat uuid` | `TABLE(message_id uuid, kind text, sequence_id uuid, sequence_name text, node_id text, step_number integer, step_label text, node_type text, variant_id text, …` | user |
| `outreach_tracking_domain_for` | `p_sender uuid` | `text` | service |
| `outreach_unsubscribe_lead` | `p_lead uuid, p_source text DEFAULT 'link'::text` | `boolean` | service |
| `outreach_update_lead_fields` | `p_ws uuid, p_match jsonb, p_fields jsonb, p_allowed text[]` | `boolean` | service |
| `outreach_update_member` | `p_ws uuid, p_user uuid, p_role outreach_role_t, p_client_ids uuid[] DEFAULT NULL::uuid[], p_can_reply boolean DEFAULT NULL::boolean` | `void` | user |
| `outreach_update_sender` | `p_sender uuid, p_patch jsonb` | `void` | user |
| `outreach_upsert_lead` | `p_ws uuid, p_lead jsonb, p_source text DEFAULT NULL::text, p_import_job uuid DEFAULT NULL::uuid` | `TABLE(id uuid, created boolean)` | user |
| `outreach_validate_graph` | `p_graph jsonb, p_pool uuid[] DEFAULT '{}'::uuid[], p_strict boolean DEFAULT false` | `jsonb` | user |
| `outreach_verify_sender_token` | `p_token text` | `uuid` | service |
| `outreach_version_usage` | `p_sequence uuid` | `TABLE(version integer, created_at timestamp with time zone, note text, publish_mode text, is_head boolean, live_leads integer)` | user |
| `outreach_visible_clients` | `p_ws uuid` | `uuid[]` | user |
| `outreach_weekly_invites_used` | `p_sender uuid, p_day date` | `integer` | user |
| `outreach_why_not_sending` | `p_sequence uuid DEFAULT NULL::uuid, p_sender uuid DEFAULT NULL::uuid, p_enrollment uuid DEFAULT NULL::uuid` | `jsonb` | user |
| `outreach_workspace_ai_settings` | `p_ws uuid` | `jsonb` | user |
| `outreach_workspace_ids` | `` | `SETOF uuid` | user |
| `outreach_workspace_members` | `p_ws uuid` | `TABLE(user_id uuid, role outreach_role_t, client_ids uuid[], can_reply boolean, email text, display_name text, created_at timestamp with time zone)` | user |
| `outreach_ws_tz` | `p_ws uuid` | `text` | user |
