/*
 * Client resources widget. The table is drawn by the server (views/widget.view.php); the
 * controls — Type filter, expanding a client, Columns, export — are evp-columns.js and
 * evp-export.js, shared with the other ElasticVue Pro reports.
 */
class WidgetEvpResources extends CWidget {

	setContents(response) {
		super.setContents(response);
		window.EvpColumns.init(this, this._body, response.evp_meta || null);
		window.EvpExport.bind(this._body, response.export || null, 'client-resources', 'Clients', () => window.EvpColumns.typeOf(this._body));
	}
}
