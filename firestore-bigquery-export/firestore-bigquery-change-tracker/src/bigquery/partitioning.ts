import { FirestoreBigQueryEventHistoryTrackerConfig } from ".";
import { FirestoreDocumentChangeEvent } from "..";
import * as firebase from "firebase-admin";

import * as logs from "../logs";
import * as bigquery from "@google-cloud/bigquery";

import { getNewPartitionField } from "./schema";
import { TableMetadata } from "@google-cloud/bigquery";

export class Partitioning {
  public config: FirestoreBigQueryEventHistoryTrackerConfig;
  public table: bigquery.Table;
  public schema: object;

  constructor(
    config: FirestoreBigQueryEventHistoryTrackerConfig,
    table?: bigquery.Table,
    schema?: object
  ) {
    this.config = config;
    this.table = table;
    this.schema = schema;
  }

  private isPartitioningEnabled(): boolean {
    const { timePartitioning } = this.config;

    return !!timePartitioning;
  }

  private isValidPartitionTypeString(value) {
    return typeof value === "string";
  }

  private async metaDataSchemaFields() {
    let metadata: TableMetadata;

    try {
      [metadata] = await this.table.getMetadata();
    } catch {
      console.log("No metadata found");
      return null;
    }

    /** Return null if no valid schema on table **/
    if (!metadata.schema) return null;

    return metadata.schema.fields;
  }

  private isValidPartitionTypeDate(value) {
    return value instanceof firebase.firestore.Timestamp;
  }

  private hasHourAndDatePartitionConfig() {
    if (
      this.config.timePartitioning === "HOUR" &&
      this.config.timePartitioningFieldType === "DATE"
    ) {
      logs.hourAndDatePartitioningWarning();
      return true;
    }

    return false;
  }

  private hasValidCustomPartitionConfig() {
    /* Return false if partition type option has not been set*/
    if (!this.isPartitioningEnabled()) return false;

    const {
      timePartitioningField,
      timePartitioningFieldType,
      timePartitioningFirestoreField,
    } = this.config;

    const hasNoCustomOptions =
      !timePartitioningField &&
      !timePartitioningFieldType &&
      !timePartitioningFirestoreField;

    /* No custom congig has been set, use partition value option only */
    if (hasNoCustomOptions) return true;

    /* check if all options have been provided to be  */
    return (
      !!timePartitioningField &&
      !!timePartitioningFieldType &&
      !!timePartitioningFirestoreField
    );
  }

  private hasValidTimePartitionOption() {
    const { timePartitioning } = this.config;

    return ["HOUR", "DAY", "MONTH", "YEAR"].includes(timePartitioning);
  }

  private hasValidTimePartitionType() {
    const { timePartitioningFieldType } = this.config;

    if (!timePartitioningFieldType || timePartitioningFieldType === undefined)
      return true;

    return ["TIMESTAMP", "DATE", "DATETIME"].includes(
      timePartitioningFieldType
    );
  }

  async hasExistingSchema() {
    const [metadata] = await this.table.getMetadata();
    return !!metadata.schema;
  }

  hasValidTableReference() {
    logs.invalidTableReference();
    return !!this.table;
  }

  private async isTablePartitioned() {
    if (!this.table) return Promise.resolve(false);
    // No table provided, cannot evaluate
    if (this.table.exists()) {
      logs.cannotPartitionExistingTable(this.table);
      return Promise.resolve(false);
    }

    /*** No table exists, return */
    const [tableExists] = await this.table.exists();
    if (!tableExists) return Promise.resolve(false);

    /* Check if partition metadata already exists */
    const [metadata] = await this.table.getMetadata();
    if (!!metadata.timePartitioning) return Promise.resolve(true);

    /** Find schema fields **/
    const schemaFields = await this.metaDataSchemaFields();

    /** No Schema exists, return */
    if (!schemaFields) return Promise.resolve(false);

    /* Return false if time partition field not found */
    return schemaFields.some(
      (column) => column.name === this.config.timePartitioningField
    );
  }

  async isValidPartitionForExistingTable(): Promise<boolean> {
    if (this.isTablePartitioned()) return false;

    return this.hasValidCustomPartitionConfig();
  }

  isValidPartitionForNewTable(): boolean {
    if (!this.isPartitioningEnabled()) return false;

    return this.hasValidCustomPartitionConfig();
  }

  /*
    Extracts a valid Partition field from the Document Change Event.
    Matches result based on a pre-defined Firestore field matching the event data object.
    Return an empty object if no field name or value provided. 
    Returns empty object if not a string or timestamp
    Logs warning if not a valid datatype
    Delete changes events have no data, return early as cannot partition on empty data.
  **/
  getPartitionValue(event: FirestoreDocumentChangeEvent) {
    if (!event.data) return {};

    const firestoreFieldName = this.config.timePartitioningFirestoreField;
    const fieldName = this.config.timePartitioningField;
    const fieldValue = event.data[firestoreFieldName];

    if (!fieldName || !fieldValue) {
      return {};
    }

    if (this.isValidPartitionTypeString(fieldValue)) {
      return { [fieldName]: fieldValue };
    }

    if (this.isValidPartitionTypeDate(fieldValue))
      return { [fieldName]: fieldValue.toDate() };

    logs.firestoreTimePartitionFieldError(
      event.documentName,
      fieldName,
      firestoreFieldName,
      fieldValue
    );

    return {};
  }

  customFieldExists(fields = []) {
    if (!fields.length) return false;

    const { timePartitioningField } = this.config;

    return fields.map(($) => $.name).includes(timePartitioningField);
  }

  async addPartitioningToSchema(fields = []): Promise<void> {
    /** check if class has valid table reference */
    if (!this.hasValidTableReference()) return Promise.resolve();

    /** return if table is already partitioned **/
    if (await this.isTablePartitioned()) return Promise.resolve();

    /** return if an invalid partition type has been requested**/
    if (!this.hasValidTimePartitionType()) return Promise.resolve();

    /** Return if invalid partitioning and field type combination */
    if (this.hasHourAndDatePartitionConfig()) return Promise.resolve();

    /** return if an invalid partition type has been requested**/
    if (!this.hasValidCustomPartitionConfig()) return Promise.resolve();

    /** return if an invalid partition type has been requested**/
    if (!this.hasValidCustomPartitionConfig()) return Promise.resolve();

    /** update fields with new schema option ** */
    if (!this.hasValidTimePartitionOption()) return Promise.resolve();

    /* Check if partition field has been provided */
    if (!this.config.timePartitioningField) return Promise.resolve();

    // if (await !this.hasExistingSchema) return Promise.resolve();

    // Field already exists on schema, skip
    if (this.customFieldExists(fields)) return Promise.resolve();

    fields.push(getNewPartitionField(this.config));

    /** log successful addition of partition column */
    logs.addPartitionFieldColumn(
      this.table.id,
      this.config.timePartitioningField
    );

    return Promise.resolve();
  }

  async updateTableMetadata(options: bigquery.TableMetadata): Promise<void> {
    /** return if table is already partitioned **/
    if (await this.isTablePartitioned()) return Promise.resolve();

    /** return if an invalid partition type has been requested**/
    if (!this.hasValidTimePartitionType()) return Promise.resolve();

    /** update fields with new schema option ** */
    if (!this.hasValidTimePartitionOption()) return Promise.resolve();

    /** Return if invalid partitioning and field type combination */
    if (this.hasHourAndDatePartitionConfig()) return Promise.resolve();

    /** return if an invalid partition type has been requested**/
    if (!this.hasValidCustomPartitionConfig()) return Promise.resolve();

    // if (await !this.hasExistingSchema) return Promise.resolve();

    if (this.config.timePartitioning) {
      options.timePartitioning = { type: this.config.timePartitioning };
    }

    //TODO: Add check for skipping adding views partition field, this is not a feature that can be added .

    if (this.config.timePartitioningField) {
      options.timePartitioning = {
        ...options.timePartitioning,
        field: this.config.timePartitioningField,
      };
    }
  }
}
