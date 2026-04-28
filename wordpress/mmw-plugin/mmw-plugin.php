<?php
/**
 * Plugin Name: Medical Marketing Whiz
 * Plugin URI:  https://mmwgrowth.com
 * Description: REST API extension for MMW Site Intelligence. Enables SEO field and schema management from the Site Intelligence dashboard.
 * Version:     1.0.0
 * Author:      Medical Marketing Whiz
 * Author URI:  https://mmwgrowth.com
 * Requires at least: 5.6
 * Requires PHP: 7.4
 */

if ( ! defined( 'ABSPATH' ) ) exit;

define( 'MMW_VERSION', '1.0.0' );

// All schema meta keys written by this plugin use this prefix.
// This keeps MMW-managed schemas separate from Rank Math's own native schemas
// and makes it safe to delete them later without touching anything else.
define( 'MMW_SCHEMA_PREFIX', 'rank_math_schema_mmw_' );

add_action( 'rest_api_init', 'mmw_register_routes' );

function mmw_register_routes() {
    $ns = 'mmw/v1';

    register_rest_route( $ns, '/ping', [
        'methods'             => 'GET',
        'callback'            => 'mmw_ping',
        'permission_callback' => 'mmw_can_edit',
    ] );

    // Single URL → post ID
    register_rest_route( $ns, '/lookup-url', [
        'methods'             => 'POST',
        'callback'            => 'mmw_lookup_url',
        'permission_callback' => 'mmw_can_edit',
    ] );

    // Bulk URL → post ID (avoids N round-trips for large crawls)
    register_rest_route( $ns, '/lookup-urls', [
        'methods'             => 'POST',
        'callback'            => 'mmw_lookup_urls',
        'permission_callback' => 'mmw_can_edit',
    ] );

    // Read all Rank Math schemas on a single post
    register_rest_route( $ns, '/schema/(?P<post_id>\\d+)', [
        'methods'             => 'GET',
        'callback'            => 'mmw_get_schemas',
        'permission_callback' => 'mmw_can_edit',
    ] );

    // Deploy a schema to a post
    register_rest_route( $ns, '/schema', [
        'methods'             => 'POST',
        'callback'            => 'mmw_deploy_schema',
        'permission_callback' => 'mmw_can_edit',
    ] );

    // Delete MMW-managed schemas from a post
    register_rest_route( $ns, '/schema/(?P<post_id>\\d+)', [
        'methods'             => 'DELETE',
        'callback'            => 'mmw_delete_schemas',
        'permission_callback' => 'mmw_can_edit',
    ] );

    // Bulk read schemas for multiple post IDs
    register_rest_route( $ns, '/schemas/bulk', [
        'methods'             => 'POST',
        'callback'            => 'mmw_get_schemas_bulk',
        'permission_callback' => 'mmw_can_edit',
    ] );

    // Write Rank Math SEO title + meta description
    register_rest_route( $ns, '/seo-meta', [
        'methods'             => 'POST',
        'callback'            => 'mmw_write_seo_meta',
        'permission_callback' => 'mmw_can_edit',
    ] );
}

function mmw_can_edit() {
    return current_user_can( 'edit_posts' );
}

// ─── Ping ─────────────────────────────────────────────────────────────────────

function mmw_ping( WP_REST_Request $request ) {
    return rest_ensure_response( [
        'ok'      => true,
        'version' => MMW_VERSION,
        'site'    => get_bloginfo( 'url' ),
        'name'    => get_bloginfo( 'name' ),
    ] );
}

// ─── URL → Post ID lookup ─────────────────────────────────────────────────────

function mmw_lookup_url( WP_REST_Request $request ) {
    $url     = trim( (string) $request->get_param( 'url' ) );
    $post_id = mmw_resolve_url( $url );
    return rest_ensure_response( [
        'url'     => $url,
        'post_id' => $post_id,
        'found'   => $post_id > 0,
    ] );
}

function mmw_lookup_urls( WP_REST_Request $request ) {
    $urls    = $request->get_param( 'urls' );
    $results = [];
    if ( is_array( $urls ) ) {
        foreach ( $urls as $url ) {
            $url       = trim( (string) $url );
            $post_id   = mmw_resolve_url( $url );
            $results[] = [
                'url'     => $url,
                'post_id' => $post_id,
                'found'   => $post_id > 0,
            ];
        }
    }
    return rest_ensure_response( [ 'results' => $results ] );
}

function mmw_resolve_url( $url ) {
    // Try the URL as-is
    $post_id = url_to_postid( $url );
    if ( $post_id ) return (int) $post_id;

    // Toggle trailing slash and retry
    $alt     = ( substr( $url, -1 ) === '/' ) ? rtrim( $url, '/' ) : $url . '/';
    $post_id = url_to_postid( $alt );
    if ( $post_id ) return (int) $post_id;

    // Check for homepage
    if ( rtrim( $url, '/' ) === rtrim( home_url(), '/' ) ) {
        $front = (int) get_option( 'page_on_front' );
        if ( $front > 0 ) return $front;
    }

    return 0;
}

// ─── Schema reads ─────────────────────────────────────────────────────────────

function mmw_get_schemas( WP_REST_Request $request ) {
    $post_id = (int) $request->get_param( 'post_id' );
    return rest_ensure_response( mmw_read_schemas( $post_id ) );
}

function mmw_get_schemas_bulk( WP_REST_Request $request ) {
    $post_ids = $request->get_param( 'post_ids' );
    $results  = [];
    if ( is_array( $post_ids ) ) {
        foreach ( $post_ids as $pid ) {
            $results[] = mmw_read_schemas( (int) $pid );
        }
    }
    return rest_ensure_response( [ 'results' => $results ] );
}

function mmw_read_schemas( $post_id ) {
    global $wpdb;

    // Read ALL rank_math_schema_* keys — this shows both MMW-deployed and
    // Rank Math's own native schemas so Site Intelligence can see everything.
    $rows = $wpdb->get_results( $wpdb->prepare(
        "SELECT meta_key, meta_value FROM {$wpdb->postmeta}
         WHERE post_id = %d AND meta_key LIKE 'rank_math_schema_%%'",
        $post_id
    ) );

    $schemas = [];
    foreach ( $rows as $row ) {
        // maybe_unserialize correctly handles the PHP serialized array format
        // that Rank Math uses. The standard WP REST meta endpoint returns the
        // raw serialized string, which JavaScript cannot parse — that's why
        // this custom endpoint exists.
        $schemas[ $row->meta_key ] = maybe_unserialize( $row->meta_value );
    }

    return [
        'post_id' => $post_id,
        'count'   => count( $schemas ),
        'schemas' => $schemas,
    ];
}

// ─── Schema deploy ────────────────────────────────────────────────────────────

function mmw_deploy_schema( WP_REST_Request $request ) {
    $post_id     = (int) $request->get_param( 'post_id' );
    $schema_type = sanitize_text_field( (string) $request->get_param( 'schema_type' ) );
    $schema      = $request->get_param( 'schema' );

    if ( is_string( $schema ) ) {
        $schema = json_decode( $schema, true );
    }

    if ( ! is_array( $schema ) || empty( $schema ) ) {
        return new WP_Error( 'invalid_schema', 'schema must be a non-empty object', [ 'status' => 400 ] );
    }

    // Deterministic unique ID per (schema_type + post_id).
    // Re-deploying the same type overwrites rather than duplicating.
    $unique_id = 'mmw_' . substr( md5( $schema_type . $post_id ), 0, 8 );
    $meta_key  = 'rank_math_schema_' . $unique_id;

    // CRITICAL: Rank Math's editor JavaScript expects a 'metadata' key at the
    // top level of every schema entry. Without it, the WP editor throws a
    // fatal JS error and the post becomes uneditable. See schema auditor
    // technical reference section 4.2 for full details.
    $stored = array_merge(
        [
            'metadata' => [
                'title'          => $schema_type,
                'type'           => 'custom',
                'shortcode'      => '',
                'isPrimary'      => false,
                'reviewLocation' => 'custom',
            ],
        ],
        $schema
    );

    // Pass the PHP array directly to update_post_meta. WordPress serializes it
    // via maybe_serialize() internally. NEVER json_encode() the schema and pass
    // a string — that will crash the Rank Math editor on every affected page.
    $result = update_post_meta( $post_id, $meta_key, $stored );

    return rest_ensure_response( [
        'ok'       => true,
        'meta_key' => $meta_key,
        'updated'  => $result !== false,
    ] );
}

// ─── Schema delete ────────────────────────────────────────────────────────────

function mmw_delete_schemas( WP_REST_Request $request ) {
    $post_id   = (int) $request->get_param( 'post_id' );
    $meta_keys = $request->get_param( 'meta_keys' ); // optional: delete specific keys

    global $wpdb;

    if ( is_array( $meta_keys ) && count( $meta_keys ) > 0 ) {
        foreach ( $meta_keys as $key ) {
            // Safety: only delete keys this plugin owns. Never touch Rank Math's
            // own native schema keys (e.g. rank_math_schema_BlogPosting).
            if ( strpos( (string) $key, MMW_SCHEMA_PREFIX ) === 0 ) {
                delete_post_meta( $post_id, sanitize_key( $key ) );
            }
        }
    } else {
        // Delete all MMW-managed schemas for this post
        $wpdb->query( $wpdb->prepare(
            "DELETE FROM {$wpdb->postmeta}
             WHERE post_id = %d AND meta_key LIKE %s",
            $post_id,
            $wpdb->esc_like( MMW_SCHEMA_PREFIX ) . '%'
        ) );
    }

    return rest_ensure_response( [ 'ok' => true, 'post_id' => $post_id ] );
}

// ─── SEO meta ─────────────────────────────────────────────────────────────────

function mmw_write_seo_meta( WP_REST_Request $request ) {
    $post_id     = (int) $request->get_param( 'post_id' );
    $title       = $request->get_param( 'title' );
    $description = $request->get_param( 'description' );
    $focus_kw    = $request->get_param( 'focus_keyword' );

    $updated = [];

    // Rank Math stores SEO title + description as post meta.
    // These take priority over Rank Math's auto-generated values.
    if ( $title !== null ) {
        update_post_meta( $post_id, 'rank_math_title', sanitize_text_field( (string) $title ) );
        $updated[] = 'title';
    }

    if ( $description !== null ) {
        update_post_meta( $post_id, 'rank_math_description', sanitize_textarea_field( (string) $description ) );
        $updated[] = 'description';
    }

    if ( $focus_kw !== null ) {
        update_post_meta( $post_id, 'rank_math_focus_keyword', sanitize_text_field( (string) $focus_kw ) );
        $updated[] = 'focus_keyword';
    }

    return rest_ensure_response( [
        'ok'      => true,
        'post_id' => $post_id,
        'updated' => $updated,
    ] );
}
