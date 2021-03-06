import { tools, define, definitions, definitionDecorator, Collection, mixinRules, Messenger } from 'type-r'
import { base64, Document } from './common'
import { Query, SelectQuery, select, QueryParts } from './queries'
import { DocumentKey, DocumentId, DocumentKeySource } from './key'
import { DocumentExtent, CouchbaseQuery } from './extent'
const couchbaseErrors = require('couchbase/lib/errors');


@define
@definitions({
    Document : mixinRules.protoValue,
    key : mixinRules.protoValue
})
export class DocumentsCollection<D extends Document = Document> extends DocumentExtent {
    static Document : typeof Document
    Document : typeof Document

    static key : DocumentId<Document>

    static instance : DocumentsCollection<Document>

    key : DocumentKey<D>

    static get asProp(){
        return definitionDecorator( 'collections', this );
    }

    // Document collections are uniquely identified with it's document key type.
    get id() : string {
        return this.key.type;
    }

    // For the document collections, there's one design doc for the collection.
    getDesignDocKey(){
        return this.id;
    }

    bucket = null;

    constructor(){
        super();
        this.key = new DocumentKey( this.key, this );
    }

    // Select query template to scan and return all docs.
    get selectDocs() : SelectQuery {
        const { id } = this.bucket;

        return select( '*', `meta(\`${id}\`).id`, `TOSTRING(meta(\`${id}\`).cas) as cas` )
                .from( this )
    }

    // Query complete documents
    async queryDocs( query : CouchbaseQuery ) : Promise< Collection<D> >{
        const rows = await this.query( query ),
            bucket = this.bucket.id;

        return new this.Document.Collection<any>(
            rows.map( row => {
                let value = row[ bucket ];

                return {
                    id : this.key.toShort( row.id ),
                    _cas : row.cas,
                    ...value
                }
            })
        );
    }

    _from( queryParts : QueryParts ){
        this.bucket._from( queryParts );
        queryParts.store = this;
    }

    _where( parts : QueryParts ){
        // let pattern = [ parts.store.key.type + '#' ],
        //     code = '';
        //
        // if( parts.code ){
        //     if( parts.code[ 0 ] === '$' ){
        //         pattern.push( parts.code );
        //     }
        //     else{
        //         pattern[ 0 ] += parts.code;
        //     }
        // }
        //
        // if( pattern.length > 1 ){
        //     pattern.push( "%" );
        // }
        // else{
        //     pattern[ 0 ] += "%";
        // }

        //console.log("name=", parts.name + ", text=",  `(meta(self).\`id\`) like ${ pattern.map( x => `"${x}"` ).join( ' || ') }`);
        //console.log(`\`_type\` = "${parts.store.key.type}"`)
        //return `(meta(self).\`id\`) like ${ pattern.map( x => `"${x}"` ).join( ' || ') }`;
        return `\`_type\` = "${parts.store.key.type}"`;
    }

    async connect( bucket, initialize : boolean ){
        this.bucket = bucket;

        this.log( 'info', 'initializing...' );
        await super.onConnect( initialize );
    }

    protected log( level, text ){
        tools.log( level, `[Couch-R] Collection ${ this.key.type }: ${ text }`);
    }

    get idAttribute(){
        return this.Document.prototype.idAttribute;
    }

    get api(){
        return this.bucket.api;
    }

    get manager(){
        return this.bucket.manager;
    }

    /**
     * get( shortId | longId ) - read document by its id.
     * get({ props }) when !idCounter - read document by composite key
     * get( document ) - fetch the document
     */
    async _get( id : DocumentKeySource<D>, method : ( key : string ) => Promise< any > )  /* this.Document */ {
        if( !id ) return null;

        const doc = id instanceof this.Document ? id : null;
        const key = this.key.get( id );

        try{
            const { value, cas } = await method( key );
            value[ this.idAttribute ] = this.key.toShort( key );
            value._cas = cas;
            value._type = this.key.type;

            return doc ? doc.set( value, { parse : true } ) :
                         new this.Document( value, { parse : true } );
        }
        catch( e ){
            if ( e.code === couchbaseErrors.keyNotFound ) {
                return null;
            } else {
                throw e
            }
        }
    }

    async get( id : DocumentKeySource<D>, options = {} ){
        return this._get( id, key => this.api.get( key, options ) ) as Promise<D>;
    }

    async getAndLock( id : DocumentKeySource<D>, options = {} ){
        return this._get( id, key => this.api.getAndLock( key, options ) ) as Promise<D>;
    }

    /**
     * unlock( document ) - unlock the previously locked document.
     */
    async unlock( doc, options = {} ){
        return this.api.unlock( this.key.get( doc ), doc._cas );
    }

    async getAndTouch( id : DocumentKeySource<D>, expiry, options = {} ){
        return this._get( id, key => this.api.getAndTouch( key, expiry, options ) );
    }

    /**
     * touch( doc, exp ) - touches the document.
     * touch( doc.id, exp ) - touches the document by its it.
     * touch({ attr1 : value, ... }) - touch the doc with a compund key.
     */
    async touch( doc, expiry, options = {} ){
        return this.api.touch( this.key.get( doc ), expiry, options );
    }

    async getMulti( ){
        // TODO: create/update collection.
    }

    async upsert( a_doc : Partial<D>, options = {} ){
        return this._insert( a_doc, 'upsert', options );
    }

    async insert( a_doc : Partial<D>, options = {} ){
        return this._insert( a_doc, 'insert', options );
    }

    async replace( a_doc : Partial<D>, options = {} ){
        return this._insert( a_doc, 'replace', options );
    }

    async _insert( a_doc : Partial<D>, method, options ){
        const doc = ( a_doc instanceof this.Document ? a_doc : new this.Document( a_doc ) ) as D,
            key = await this.key.make( doc );

        // TODO: handle idAttribute
        const json = doc.toJSON(),
             cas = (json as any)._cas;

        ( json as any )._type = this.key.type;

        delete ( json as any )._cas;
        delete json[ this.idAttribute ];

        let result = await this.api[ method ]( key, json, cas ? { cas, ...options } : options );

        // Update document cas and id (and type, since it not used before insert)
        doc.set({
            id: this.key.toShort( key ),
            _cas: result.cas,
            _type: this.key.type
        })

        this.trigger( 'write', doc, key, this );
        this.bucket.trigger( 'write', doc, key, this );

        return doc;
    }

    /**
     * remove( doc ) will check the cas.
     * remove( doc.id ) will ignore cas.
     * remove({ field : 'a', ... }) will delete doc with compond key.
     */
    async remove( document : Partial<D> | string, a_options = {} ){
        const key = this.key.get( document ),
            cas = typeof document === 'string' ? null : document._cas,
            doc = cas ? document : null;

        const options = cas ? { cas, ...a_options } : a_options;

        await this.api.remove( key, options );

        const shortId = this.key.toShort( key );
        this.trigger( 'remove', doc, shortId, this );
        this.bucket.trigger( 'remove', doc, shortId, this );
    }
}