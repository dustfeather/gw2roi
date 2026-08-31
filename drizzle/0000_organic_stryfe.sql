CREATE TABLE `account_balance` (
	`recorded_at` integer PRIMARY KEY NOT NULL,
	`coin` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `craft_roi` (
	`recipe_id` integer PRIMARY KEY NOT NULL,
	`output_item_id` integer DEFAULT 0 NOT NULL,
	`output_item_name` text DEFAULT '' NOT NULL,
	`output_item_count` integer NOT NULL,
	`craft_cost` integer NOT NULL,
	`list_revenue` integer NOT NULL,
	`profit` integer NOT NULL,
	`roi_pct` real NOT NULL,
	`out_of_pocket` integer DEFAULT 0 NOT NULL,
	`owned_value` integer DEFAULT 0 NOT NULL,
	`net_profit` integer DEFAULT 0 NOT NULL,
	`net_roi_pct` real DEFAULT 0 NOT NULL,
	`instant_sell_revenue` integer NOT NULL,
	`sell_price` integer NOT NULL,
	`buy_price` integer NOT NULL,
	`sell_quantity` integer NOT NULL,
	`sell_sold_day` integer NOT NULL,
	`days_to_sell` real NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `craft_roi_learnable` (
	`recipe_id` integer PRIMARY KEY NOT NULL,
	`output_item_id` integer DEFAULT 0 NOT NULL,
	`output_item_name` text DEFAULT '' NOT NULL,
	`output_item_count` integer NOT NULL,
	`learn_method` text DEFAULT '' NOT NULL,
	`craft_cost` integer NOT NULL,
	`list_revenue` integer NOT NULL,
	`profit` integer NOT NULL,
	`roi_pct` real NOT NULL,
	`out_of_pocket` integer DEFAULT 0 NOT NULL,
	`owned_value` integer DEFAULT 0 NOT NULL,
	`net_profit` integer DEFAULT 0 NOT NULL,
	`net_roi_pct` real DEFAULT 0 NOT NULL,
	`instant_sell_revenue` integer NOT NULL,
	`sell_price` integer NOT NULL,
	`buy_price` integer NOT NULL,
	`sell_quantity` integer NOT NULL,
	`sell_sold_day` integer NOT NULL,
	`days_to_sell` real NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `item_defs` (
	`id` integer PRIMARY KEY NOT NULL,
	`def` text NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `item_defs_fetched_at_idx` ON `item_defs` (`fetched_at`);--> statement-breakpoint
CREATE TABLE `recipe_defs` (
	`id` integer PRIMARY KEY NOT NULL,
	`def` text NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recipe_defs_fetched_at_idx` ON `recipe_defs` (`fetched_at`);--> statement-breakpoint
CREATE TABLE `tp_transactions` (
	`id` integer PRIMARY KEY NOT NULL,
	`item_id` integer NOT NULL,
	`kind` text NOT NULL,
	`price` integer NOT NULL,
	`quantity` integer NOT NULL,
	`purchased_at` integer NOT NULL
);
