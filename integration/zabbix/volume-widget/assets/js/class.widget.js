/*
 * Volume report widget. The table is drawn by the server (views/widget.view.php); the Type
 * filter and Columns dialog are evp-columns.js, the export evp-export.js — shared with the other
 * ElasticVue Pro reports.
 */
class WidgetEvpVolume extends CWidget {

	setContents(response) {
		super.setContents(response);
		window.EvpColumns.init(this, this._body, response.evp_meta || null);
		window.EvpExport.bind(this._body, response.export || null, 'volume-report', 'Volume report', () => window.EvpColumns.typeOf(this._body));
	}
}
